package server

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/OVINC-CN/Veilink/apps/server/internal/config"
	"github.com/OVINC-CN/Veilink/apps/server/internal/protocol"
	"github.com/OVINC-CN/Veilink/apps/server/internal/store"
	"github.com/coder/websocket"
)

type binding struct {
	RoomID          string
	MemberID        string
	SessionID       string
	SnapshotVersion int64
}

type connection struct {
	id                   string
	publicIP             string
	socket               *websocket.Conn
	server               *Server
	writeMu              sync.Mutex
	stateMu              sync.RWMutex
	binding              *binding
	malformed            int
	messageWindowStarted time.Time
	messageCount         int
	messageBytes         int
	closed               atomic.Bool
	registered           atomic.Bool
	done                 chan struct{}
	closeOnce            sync.Once
}

type Server struct {
	cfg           config.Config
	store         *store.Store
	mux           *http.ServeMux
	connections   map[string]*connection
	connectionsMu sync.RWMutex
	staticIndex   string
	staticReady   bool
	stop          chan struct{}
	stopOnce      sync.Once
	workers       sync.WaitGroup
}

type publicConfig struct {
	ProtocolVersion     int               `json:"protocolVersion"`
	Limits              publicLimits      `json:"limits"`
	HeartbeatIntervalMS int64             `json:"heartbeatIntervalMs"`
	DisconnectGraceMS   int64             `json:"disconnectGraceMs"`
	ICEServers          []publicICEServer `json:"iceServers"`
}

type publicLimits struct {
	MaxMembers    int   `json:"maxMembers"`
	MaxRoomTTLMS  int64 `json:"maxRoomTtlMs"`
	RoomTTLMS     int64 `json:"roomTtlMs"`
	MaxFileSizeMB int   `json:"maxFileSizeMb"`
}

type publicICEServer struct {
	URLs []string `json:"urls"`
}

func New(cfg config.Config, state *store.Store) *Server {
	server := &Server{
		cfg:         cfg,
		store:       state,
		mux:         http.NewServeMux(),
		connections: make(map[string]*connection),
		staticIndex: filepath.Join(cfg.StaticRoot, "index.html"),
		stop:        make(chan struct{}),
	}
	if info, err := os.Stat(server.staticIndex); err == nil && info.Mode().IsRegular() {
		server.staticReady = true
	}
	server.mux.HandleFunc("/healthz", server.health)
	server.mux.HandleFunc("/api/config", server.apiConfig)
	server.mux.HandleFunc("/signal", server.signal)
	server.mux.HandleFunc("/", server.static)
	server.workers.Add(2)
	go server.dispatchEvents()
	go server.sweepLoop()
	return server
}

func (s *Server) Handler() http.Handler {
	return s.securityHeaders(s.mux)
}

func (s *Server) Close(ctx context.Context) error {
	s.stopOnce.Do(func() { close(s.stop) })
	s.connectionsMu.RLock()
	connections := make([]*connection, 0, len(s.connections))
	for _, current := range s.connections {
		connections = append(connections, current)
	}
	s.connectionsMu.RUnlock()
	for _, current := range connections {
		current.close(websocket.StatusGoingAway, "server shutdown")
	}
	wait := make(chan struct{})
	go func() {
		s.workers.Wait()
		close(wait)
	}()
	select {
	case <-wait:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Cache-Control", "no-store, max-age=0")
		response.Header().Set("Pragma", "no-cache")
		response.Header().Set("Expires", "0")
		response.Header().Set("Content-Security-Policy", "default-src 'self'; base-uri 'none'; child-src 'none'; connect-src 'self'; font-src 'self'; form-action 'none'; frame-ancestors 'none'; frame-src 'none'; img-src 'self' data: blob:; manifest-src 'self'; media-src 'self' blob:; object-src 'none'; script-src 'self' 'wasm-unsafe-eval'; script-src-attr 'none'; style-src 'self'; style-src-attr 'unsafe-inline'; style-src-elem 'self'; worker-src 'self' blob:")
		response.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		response.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		response.Header().Set("Permissions-Policy", "accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()")
		response.Header().Set("Referrer-Policy", "no-referrer")
		response.Header().Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload")
		response.Header().Set("X-Content-Type-Options", "nosniff")
		response.Header().Set("X-Frame-Options", "DENY")
		response.Header().Set("X-Permitted-Cross-Domain-Policies", "none")
		response.Header().Set("X-Robots-Tag", "noindex, nofollow, noarchive")
		next.ServeHTTP(response, request)
	})
}

func (s *Server) health(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		methodNotAllowed(response)
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 2*time.Second)
	defer cancel()
	if !s.store.Healthy(ctx) {
		writeJSON(response, http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
		return
	}
	writeJSON(response, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) apiConfig(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		methodNotAllowed(response)
		return
	}
	if !s.originAllowed(request, false) {
		writeJSON(response, http.StatusForbidden, map[string]string{"error": "forbidden_origin"})
		return
	}
	writeJSON(response, http.StatusOK, publicConfig{
		ProtocolVersion:     protocol.Version,
		Limits:              publicLimits{MaxMembers: s.cfg.MaxMembers, MaxRoomTTLMS: config.MaxRoomTTL.Milliseconds(), RoomTTLMS: s.cfg.RoomTTL.Milliseconds(), MaxFileSizeMB: 256},
		HeartbeatIntervalMS: s.cfg.HeartbeatInterval.Milliseconds(),
		DisconnectGraceMS:   s.cfg.DisconnectGrace.Milliseconds(),
		ICEServers:          []publicICEServer{{URLs: append([]string(nil), s.cfg.STUNURLs...)}},
	})
}

func (s *Server) signal(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		methodNotAllowed(response)
		return
	}
	if request.URL.RawQuery != "" || !s.originAllowed(request, true) {
		writeJSON(response, http.StatusForbidden, map[string]string{"error": "forbidden_origin"})
		return
	}
	connectionID, err := randomID(16)
	if err != nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]string{"error": "state_unavailable"})
		return
	}
	publicIP := s.publicIP(request)
	ctx, cancel := context.WithTimeout(request.Context(), 5*time.Second)
	registered, err := s.store.RegisterConnection(ctx, connectionID, publicIP)
	cancel()
	if err != nil || !registered {
		writeJSON(response, http.StatusServiceUnavailable, map[string]string{"error": "connection_capacity_reached"})
		return
	}
	socket, err := websocket.Accept(response, request, &websocket.AcceptOptions{InsecureSkipVerify: true, CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = s.store.RemoveConnection(cleanupCtx, connectionID, publicIP)
		cleanupCancel()
		return
	}
	socket.SetReadLimit(protocol.MaxSignalBytes)
	connection := &connection{id: connectionID, publicIP: publicIP, socket: socket, server: s, done: make(chan struct{})}
	connection.registered.Store(true)
	s.connectionsMu.Lock()
	s.connections[connection.id] = connection
	s.connectionsMu.Unlock()
	s.workers.Add(1)
	defer s.workers.Done()
	connection.run(context.Background())
}

func (s *Server) originAllowed(request *http.Request, required bool) bool {
	origins := request.Header.Values("Origin")
	if len(origins) > 1 {
		return false
	}
	origin := ""
	if len(origins) == 1 {
		origin = origins[0]
	}
	if s.cfg.AppOrigin == "" {
		return !required || origin == ""
	}
	if origin == "" {
		return !required
	}
	return origin == s.cfg.AppOrigin
}

func (c *connection) run(parent context.Context) {
	heartbeatDone := make(chan struct{})
	go func() {
		c.heartbeatLoop(parent)
		close(heartbeatDone)
	}()
	for {
		messageType, data, err := c.socket.Read(parent)
		if err != nil {
			break
		}
		if messageType != websocket.MessageText {
			if c.rejectMalformed("invalid_request", "") {
				break
			}
			continue
		}
		if !c.allowMessage(len(data)) {
			c.sendError("rate_limited", "", "")
			c.close(websocket.StatusPolicyViolation, "signaling rate exceeded")
			break
		}
		envelope, err := protocol.DecodeClient(data)
		if err != nil {
			code := "invalid_request"
			if strings.Contains(err.Error(), "unsupported version") {
				code = "unsupported_version"
			}
			if c.rejectMalformed(code, "") {
				break
			}
			continue
		}
		if err := c.handle(parent, envelope); err != nil {
			code, internal := mapError(err)
			c.sendError(code, envelope.RequestID, envelope.RoomID)
			if internal {
				c.close(websocket.StatusTryAgainLater, "state unavailable")
				break
			}
		}
	}
	c.cleanup()
	<-heartbeatDone
}

func (c *connection) heartbeatLoop(parent context.Context) {
	ticker := time.NewTicker(c.server.cfg.HeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			pingCtx, cancel := context.WithTimeout(parent, c.server.cfg.HeartbeatInterval/2)
			err := c.socket.Ping(pingCtx)
			cancel()
			if err != nil {
				c.close(websocket.StatusPolicyViolation, "heartbeat timeout")
				return
			}
			opCtx, opCancel := context.WithTimeout(context.Background(), 5*time.Second)
			refreshed, err := c.server.store.RefreshConnection(opCtx, c.id, c.publicIP)
			if err == nil && refreshed {
				if current := c.getBinding(); current != nil {
					_, err = c.server.store.Touch(opCtx, current.RoomID, current.MemberID, current.SessionID)
				}
			}
			opCancel()
			if err != nil || !refreshed {
				c.close(websocket.StatusTryAgainLater, "state unavailable")
				return
			}
		case <-c.done:
			return
		case <-c.server.stop:
			return
		}
	}
}

func (c *connection) handle(parent context.Context, envelope protocol.ClientEnvelope) error {
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	switch envelope.Type {
	case "room.create":
		if c.getBinding() != nil {
			return actionError("already_in_room")
		}
		payload, err := protocol.DecodePayload[protocol.RoomCreatePayload](envelope.Payload)
		if err != nil {
			return actionError("invalid_request")
		}
		payload, err = protocol.ValidateCreate(payload)
		if err != nil {
			return actionError("invalid_request")
		}
		allowed, err := c.server.store.ConsumeRoomCreateAttempt(ctx, c.publicIP)
		if err != nil {
			return err
		}
		if !allowed {
			return &store.StoreError{Code: store.ErrRateLimited}
		}
		key, err := base64.RawURLEncoding.DecodeString(payload.AdmissionVerifier)
		if err != nil || len(key) != 32 {
			return actionError("invalid_request")
		}
		session, err := c.server.store.CreateRoom(ctx, envelope.RoomID, key, payload.Nickname, payload.IdentityPublicKey, c.id, c.publicIP)
		for index := range key {
			key[index] = 0
		}
		if err != nil {
			return err
		}
		return c.bind(envelope, session, "room.created")
	case "room.challenge":
		if c.getBinding() != nil {
			return actionError("already_in_room")
		}
		payload, err := protocol.DecodePayload[protocol.RoomChallengePayload](envelope.Payload)
		if err != nil {
			return actionError("invalid_request")
		}
		payload, err = protocol.ValidateChallenge(payload)
		if err != nil {
			return actionError("invalid_request")
		}
		challenge, err := c.server.store.IssueChallenge(ctx, envelope.RoomID, c.id, c.publicIP, payload.Nickname, payload.IdentityPublicKey)
		if err != nil {
			return err
		}
		return c.send(protocol.Frame("room.challenge", envelope.RoomID, envelope.RequestID, map[string]any{"challengeId": challenge.ID, "challenge": challenge.Nonce, "expiresAt": challenge.ExpiresAt}))
	case "room.join":
		if c.getBinding() != nil {
			return actionError("already_in_room")
		}
		payload, err := protocol.DecodePayload[protocol.RoomJoinPayload](envelope.Payload)
		if err != nil {
			return actionError("invalid_request")
		}
		payload, err = protocol.ValidateJoin(payload)
		if err != nil {
			return actionError("invalid_request")
		}
		if err := c.server.store.ConsumeChallenge(ctx, envelope.RoomID, payload.ChallengeID, payload.Proof, c.id, c.publicIP, payload.Nickname, payload.IdentityPublicKey); err != nil {
			return err
		}
		session, err := c.server.store.JoinRoom(ctx, envelope.RoomID, payload.Nickname, payload.IdentityPublicKey, c.id)
		if err != nil {
			return err
		}
		return c.bind(envelope, session, "room.joined")
	case "room.resume":
		if c.getBinding() != nil {
			return actionError("already_in_room")
		}
		payload, err := protocol.DecodePayload[protocol.RoomResumePayload](envelope.Payload)
		if err != nil || protocol.ValidateResume(payload) != nil {
			return actionError("invalid_request")
		}
		session, err := c.server.store.ResumeRoom(ctx, envelope.RoomID, payload.MemberID, payload.ResumeToken, payload.IdentityPublicKey, c.id)
		if err != nil {
			return err
		}
		return c.bind(envelope, session, "room.resumed")
	case "room.leave":
		if _, err := protocol.DecodePayload[protocol.EmptyPayload](envelope.Payload); err != nil {
			return actionError("invalid_request")
		}
		current := c.requireBinding(envelope.RoomID)
		if current == nil {
			return actionError("not_in_room")
		}
		if err := c.server.store.Leave(ctx, current.RoomID, current.MemberID, current.SessionID); err != nil {
			return err
		}
		c.setBinding(nil)
		c.close(websocket.StatusNormalClosure, "left room")
		return nil
	case "room.destroy":
		if _, err := protocol.DecodePayload[protocol.EmptyPayload](envelope.Payload); err != nil {
			return actionError("invalid_request")
		}
		current := c.requireBinding(envelope.RoomID)
		if current == nil {
			return actionError("not_in_room")
		}
		return c.server.store.Destroy(ctx, current.RoomID, current.MemberID, current.SessionID)
	case "rtc.description":
		current := c.requireBinding(envelope.RoomID)
		if current == nil {
			return actionError("not_in_room")
		}
		payload, err := protocol.DecodePayload[protocol.TargetDescriptionPayload](envelope.Payload)
		if err != nil || protocol.ValidateDescription(payload) != nil {
			return actionError("invalid_signal")
		}
		return c.server.store.ForwardRTC(ctx, current.RoomID, current.MemberID, current.SessionID, payload.TargetMemberID, envelope.Type, payload.Description)
	case "rtc.candidate":
		current := c.requireBinding(envelope.RoomID)
		if current == nil {
			return actionError("not_in_room")
		}
		payload, err := protocol.DecodePayload[protocol.TargetCandidatePayload](envelope.Payload)
		if err != nil || protocol.ValidateCandidate(payload) != nil {
			return actionError("invalid_signal")
		}
		return c.server.store.ForwardRTC(ctx, current.RoomID, current.MemberID, current.SessionID, payload.TargetMemberID, envelope.Type, payload.Candidate)
	case "heartbeat":
		current := c.requireBinding(envelope.RoomID)
		if current == nil {
			return actionError("not_in_room")
		}
		payload, err := protocol.DecodePayload[protocol.HeartbeatPayload](envelope.Payload)
		if err != nil || payload.SentAt < 0 {
			return actionError("invalid_request")
		}
		snapshot, err := c.server.store.Touch(ctx, current.RoomID, current.MemberID, current.SessionID)
		if err != nil {
			return err
		}
		if snapshot == nil {
			return actionError("session_expired")
		}
		if snapshot.SnapshotVersion != current.SnapshotVersion {
			current.SnapshotVersion = snapshot.SnapshotVersion
			c.setBinding(current)
			if err := c.send(protocol.Frame("room.snapshot", current.RoomID, "", *snapshot)); err != nil {
				return err
			}
		}
		return c.send(protocol.Frame("heartbeat.ack", envelope.RoomID, envelope.RequestID, map[string]int64{"sentAt": payload.SentAt, "serverNow": time.Now().UnixMilli()}))
	default:
		return actionError("invalid_request")
	}
}

func (c *connection) bind(envelope protocol.ClientEnvelope, session store.Session, frameType string) error {
	c.setBinding(&binding{RoomID: envelope.RoomID, MemberID: session.MemberID, SessionID: session.SessionID, SnapshotVersion: session.Snapshot.SnapshotVersion})
	payload := protocol.SessionConfirmation{SelfMemberID: session.MemberID, ResumeToken: session.ResumeToken, Snapshot: session.Snapshot}
	return c.send(protocol.Frame(frameType, envelope.RoomID, envelope.RequestID, payload))
}

func (c *connection) rejectMalformed(code, roomID string) bool {
	c.stateMu.Lock()
	c.malformed++
	count := c.malformed
	c.stateMu.Unlock()
	c.sendError(code, "", roomID)
	if count >= 3 {
		c.close(websocket.StatusPolicyViolation, "invalid messages")
		return true
	}
	return false
}

func (c *connection) allowMessage(size int) bool {
	now := time.Now()
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	if c.messageWindowStarted.IsZero() || now.Sub(c.messageWindowStarted) >= 10*time.Second {
		c.messageWindowStarted = now
		c.messageCount = 0
		c.messageBytes = 0
	}
	c.messageCount++
	c.messageBytes += size
	return c.messageCount <= 256 && c.messageBytes <= 2*1024*1024
}

func (c *connection) send(frame protocol.WireFrame) error {
	if c.closed.Load() {
		return nil
	}
	data, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	if len(data) > protocol.MaxSignalBytes {
		return errors.New("outbound signal too large")
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return c.socket.Write(ctx, websocket.MessageText, data)
}

func (c *connection) sendError(code, requestID, roomID string) {
	payload := protocol.ErrorPayload{Code: code, Message: errorMessage(code)}
	if code == "rate_limited" {
		payload.RetryAfterMS = (10 * time.Minute).Milliseconds()
	}
	_ = c.send(protocol.Frame("error", roomID, requestID, payload))
}

func (c *connection) close(code websocket.StatusCode, reason string) {
	c.closeOnce.Do(func() {
		c.closed.Store(true)
		close(c.done)
		_ = c.socket.Close(code, reason)
	})
}

func (c *connection) cleanup() {
	c.close(websocket.StatusNormalClosure, "connection closed")
	c.server.connectionsMu.Lock()
	delete(c.server.connections, c.id)
	c.server.connectionsMu.Unlock()
	current := c.getBinding()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if current != nil {
		_ = c.server.store.Disconnect(ctx, current.RoomID, current.MemberID, current.SessionID)
	}
	if c.registered.Load() {
		_ = c.server.store.RemoveConnection(ctx, c.id, c.publicIP)
	}
	c.setBinding(nil)
}

func (c *connection) getBinding() *binding {
	c.stateMu.RLock()
	defer c.stateMu.RUnlock()
	if c.binding == nil {
		return nil
	}
	copy := *c.binding
	return &copy
}

func (c *connection) setBinding(value *binding) {
	c.stateMu.Lock()
	c.binding = value
	c.stateMu.Unlock()
}

func (c *connection) requireBinding(roomID string) *binding {
	current := c.getBinding()
	if current == nil || current.RoomID != roomID {
		return nil
	}
	return current
}

func (s *Server) dispatchEvents() {
	defer s.workers.Done()
	for {
		select {
		case event := <-s.store.Events():
			s.dispatch(event)
		case <-s.stop:
			return
		}
	}
}

func (s *Server) dispatch(event store.Event) {
	if event.SessionReplaced != nil {
		s.connectionsMu.RLock()
		connection := s.connections[event.SessionReplaced.SessionID]
		s.connectionsMu.RUnlock()
		if connection != nil {
			current := connection.getBinding()
			if current != nil && current.RoomID == event.SessionReplaced.RoomID && current.MemberID == event.SessionReplaced.MemberID {
				connection.setBinding(nil)
				connection.close(websocket.StatusPolicyViolation, "session replaced")
			}
		}
		return
	}
	if event.Wire == nil {
		return
	}
	s.connectionsMu.RLock()
	connections := make([]*connection, 0, len(s.connections))
	for _, current := range s.connections {
		connections = append(connections, current)
	}
	s.connectionsMu.RUnlock()
	for _, current := range connections {
		currentBinding := current.getBinding()
		if currentBinding == nil || currentBinding.RoomID != event.Wire.RoomID || event.Wire.ExcludedMemberID == currentBinding.MemberID || (event.Wire.TargetMemberID != "" && event.Wire.TargetMemberID != currentBinding.MemberID) || (event.Wire.TargetSessionID != "" && event.Wire.TargetSessionID != currentBinding.SessionID) {
			continue
		}
		frame := event.Wire.Event
		frame.RoomID = event.Wire.RoomID
		_ = current.send(frame)
		if version := snapshotVersion(frame.Payload); version > currentBinding.SnapshotVersion {
			currentBinding.SnapshotVersion = version
			current.setBinding(currentBinding)
		}
		if frame.Type == "room.ended" {
			current.setBinding(nil)
		}
	}
}

func snapshotVersion(payload any) int64 {
	if object, ok := payload.(map[string]any); ok {
		if value, ok := object["snapshotVersion"].(float64); ok && value >= 0 {
			return int64(value)
		}
	}
	return -1
}

func (s *Server) sweepLoop() {
	defer s.workers.Done()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_ = s.store.Sweep(ctx)
			cancel()
		case <-s.stop:
			return
		}
	}
}

func (s *Server) publicIP(request *http.Request) string {
	host, _, err := net.SplitHostPort(request.RemoteAddr)
	if err != nil {
		host = request.RemoteAddr
	}
	direct := net.ParseIP(strings.TrimSpace(host))
	if direct == nil {
		return "0.0.0.0"
	}
	if !s.trustedIP(direct) {
		return direct.String()
	}
	forwardedHeaders := request.Header.Values("X-Forwarded-For")
	if len(forwardedHeaders) == 0 {
		return direct.String()
	}
	forwarded := strings.Split(strings.Join(forwardedHeaders, ","), ",")
	if len(forwarded) > 32 {
		return direct.String()
	}
	chain := make([]net.IP, 0, len(forwarded)+1)
	for _, value := range forwarded {
		parsed := net.ParseIP(strings.TrimSpace(value))
		if parsed == nil {
			return direct.String()
		}
		chain = append(chain, parsed)
	}
	chain = append(chain, direct)
	for index := len(chain) - 1; index >= 0; index-- {
		if !s.trustedIP(chain[index]) {
			return chain[index].String()
		}
	}
	return direct.String()
}

func (s *Server) trustedIP(ip net.IP) bool {
	for _, network := range s.cfg.TrustedProxyNets {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}

func (s *Server) static(response http.ResponseWriter, request *http.Request) {
	if strings.HasPrefix(request.URL.Path, "/api/") || request.URL.Path == "/signal" {
		writeJSON(response, http.StatusNotFound, map[string]string{"error": "not_found"})
		return
	}
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		methodNotAllowed(response)
		return
	}
	if !s.staticReady {
		writeJSON(response, http.StatusNotFound, map[string]string{"error": "not_found"})
		return
	}
	decoded, err := url.PathUnescape(request.URL.Path)
	if err != nil || strings.ContainsAny(decoded, "\x00\\") {
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid_path"})
		return
	}
	relative := strings.TrimPrefix(filepath.Clean("/"+decoded), "/")
	target := filepath.Join(s.cfg.StaticRoot, relative)
	if !withinRoot(s.cfg.StaticRoot, target) {
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid_path"})
		return
	}
	info, statErr := os.Stat(target)
	if statErr != nil || !info.Mode().IsRegular() {
		if !strings.Contains(request.Header.Get("Accept"), "text/html") {
			writeJSON(response, http.StatusNotFound, map[string]string{"error": "not_found"})
			return
		}
		target = s.staticIndex
		info, _ = os.Stat(target)
	}
	resolvedTarget, err := filepath.EvalSymlinks(target)
	if err != nil || !withinRoot(s.cfg.StaticRoot, resolvedTarget) {
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid_path"})
		return
	}
	target = resolvedTarget
	file, err := os.Open(target)
	if err != nil {
		writeJSON(response, http.StatusNotFound, map[string]string{"error": "not_found"})
		return
	}
	defer file.Close()
	if contentType := mime.TypeByExtension(filepath.Ext(target)); contentType != "" {
		response.Header().Set("Content-Type", contentType)
	}
	http.ServeContent(response, request, info.Name(), info.ModTime(), file)
}

func withinRoot(root, target string) bool {
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		resolvedRoot, err = filepath.Abs(root)
		if err != nil {
			return false
		}
	}
	resolvedTarget, err := filepath.Abs(target)
	if err != nil {
		return false
	}
	relative, err := filepath.Rel(resolvedRoot, resolvedTarget)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

type actionError string

func (e actionError) Error() string { return string(e) }

func mapError(err error) (string, bool) {
	var action actionError
	if errors.As(err, &action) {
		switch string(action) {
		case "already_in_room", "not_in_room":
			return "forbidden", false
		case "session_expired":
			return "member_not_found", false
		case "invalid_signal":
			return "invalid_signal", false
		default:
			return "invalid_request", false
		}
	}
	var stateError *store.StoreError
	if errors.As(err, &stateError) {
		mapping := map[store.ErrorCode]string{
			store.ErrRoomExists: "room_exists", store.ErrRoomNotFound: "room_not_found", store.ErrRoomCapacity: "room_full", store.ErrServerCapacity: "room_full", store.ErrAlreadyInRoom: "forbidden", store.ErrMemberNotFound: "member_not_found", store.ErrResumeRejected: "resume_rejected", store.ErrNotOwner: "forbidden", store.ErrTargetNotFound: "member_not_found", store.ErrRateLimited: "rate_limited", store.ErrChallengeRejected: "challenge_expired", store.ErrAdmissionFailed: "bad_proof",
		}
		if code, ok := mapping[stateError.Code]; ok {
			return code, false
		}
	}
	return "internal_error", true
}

func errorMessage(code string) string {
	messages := map[string]string{
		"invalid_request": "The request is invalid.", "unsupported_version": "The protocol version is unsupported.", "room_not_found": "The invitation is unavailable.", "room_exists": "Creation could not be completed. Please retry.", "room_full": "The participant limit has been reached.", "room_expired": "The invitation has expired.", "challenge_expired": "The admission challenge is invalid or expired.", "bad_proof": "Admission verification failed.", "rate_limited": "Too many admission attempts.", "resume_rejected": "The secure connection cannot be restored.", "forbidden": "This action is not permitted.", "member_not_found": "The participant is unavailable.", "invalid_signal": "The WebRTC signal violates the direct transport policy.", "internal_error": "The server could not process the request.",
	}
	if message, ok := messages[code]; ok {
		return message
	}
	return messages["internal_error"]
}

func randomID(size int) (string, error) {
	value := make([]byte, size)
	if _, err := io.ReadFull(rand.Reader, value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}

func methodNotAllowed(response http.ResponseWriter) {
	writeJSON(response, http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})
}

func Address(cfg config.Config) string {
	return net.JoinHostPort(cfg.Host, fmt.Sprintf("%d", cfg.Port))
}
