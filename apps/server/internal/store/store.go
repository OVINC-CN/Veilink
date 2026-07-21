package store

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/OVINC-CN/Veilink/apps/server/internal/config"
	"github.com/OVINC-CN/Veilink/apps/server/internal/protocol"
	"github.com/redis/go-redis/v9"
)

type ErrorCode string

const (
	ErrRoomExists        ErrorCode = "room_exists"
	ErrRoomNotFound      ErrorCode = "room_not_found"
	ErrRoomCapacity      ErrorCode = "room_capacity_reached"
	ErrServerCapacity    ErrorCode = "server_capacity_reached"
	ErrAlreadyInRoom     ErrorCode = "already_in_room"
	ErrMemberNotFound    ErrorCode = "member_not_found"
	ErrResumeRejected    ErrorCode = "resume_rejected"
	ErrNotOwner          ErrorCode = "not_owner"
	ErrTargetNotFound    ErrorCode = "target_not_found"
	ErrRateLimited       ErrorCode = "rate_limited"
	ErrChallengeRejected ErrorCode = "challenge_rejected"
	ErrAdmissionFailed   ErrorCode = "admission_failed"
)

type StoreError struct{ Code ErrorCode }

func (e *StoreError) Error() string { return string(e.Code) }

func IsCode(err error, code ErrorCode) bool {
	var target *StoreError
	return errors.As(err, &target) && target.Code == code
}

type Session struct {
	MemberID    string
	SessionID   string
	ResumeToken string
	Snapshot    protocol.RoomSnapshot
}

type WireEvent struct {
	Kind             string             `json:"kind"`
	RoomID           string             `json:"roomId"`
	Event            protocol.WireFrame `json:"event"`
	ExcludedMemberID string             `json:"excludedMemberId,omitempty"`
	TargetMemberID   string             `json:"targetMemberId,omitempty"`
	TargetSessionID  string             `json:"targetSessionId,omitempty"`
}

type SessionReplacedEvent struct {
	Kind      string `json:"kind"`
	RoomID    string `json:"roomId"`
	MemberID  string `json:"memberId"`
	SessionID string `json:"sessionId"`
}

type Event struct {
	Wire            *WireEvent
	SessionReplaced *SessionReplacedEvent
}

type storedMember struct {
	ID                string `json:"id"`
	Nickname          string `json:"nickname"`
	IdentityPublicKey string `json:"identityPublicKey"`
	JoinedAt          int64  `json:"joinedAt"`
	ResumeTokenHash   string `json:"resumeTokenHash"`
	SessionID         string `json:"sessionId"`
}

type storedRoom struct {
	SchemaVersion   int            `json:"schemaVersion"`
	ID              string         `json:"id"`
	AdmissionKey    string         `json:"admissionKey"`
	SnapshotVersion int64          `json:"snapshotVersion"`
	OwnerID         *string        `json:"ownerId"`
	CreatorIPHash   string         `json:"creatorIpHash"`
	CreatedAt       int64          `json:"createdAt"`
	ExpiresAt       int64          `json:"expiresAt"`
	Members         []storedMember `json:"members"`
}

type storedChallenge struct {
	ID                string `json:"id"`
	Nonce             string `json:"nonce"`
	RoomID            string `json:"roomId"`
	TransportID       string `json:"transportId"`
	PublicIPHash      string `json:"publicIpHash"`
	Nickname          string `json:"nickname"`
	IdentityPublicKey string `json:"identityPublicKey"`
	ExpiresAt         int64  `json:"expiresAt"`
}

type Challenge struct {
	ID        string `json:"challengeId"`
	Nonce     string `json:"nonce"`
	ExpiresAt int64  `json:"expiresAt"`
}

type internalEnvelope struct {
	V      int               `json:"v"`
	Events []json.RawMessage `json:"events"`
}

type eventEnvelope struct {
	V      int   `json:"v"`
	Events []any `json:"events"`
}

type Store struct {
	client            *redis.Client
	subscriber        *redis.Client
	pubsub            *redis.PubSub
	base              string
	channel           string
	roomTTL           time.Duration
	maxRooms          int
	maxMembers        int
	maxRoomsPerIP     int
	createRate        int
	maxConnections    int
	maxConnectionsIP  int
	heartbeatInterval time.Duration
	disconnectGrace   time.Duration
	challengeTTL      time.Duration
	ipHashSecret      []byte
	events            chan Event
	healthy           atomic.Bool
	closeOnce         sync.Once
}

const casRoomScript = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[13] ~= '' and redis.call('GET', KEYS[5]) ~= ARGV[13] then return -1 end
if ARGV[2] == '' then
  redis.call('DEL', KEYS[1])
  redis.call('ZREM', KEYS[2], ARGV[4])
  if ARGV[12] == '1' then redis.call('ZREM', KEYS[6], ARGV[4]) end
else
  redis.call('SET', KEYS[1], ARGV[2], 'PXAT', ARGV[3])
  redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4])
end
if ARGV[6] == 'set' then
  redis.call('SET', KEYS[5], ARGV[7], 'PX', ARGV[8])
  redis.call('ZADD', KEYS[3], ARGV[9], ARGV[10])
elseif ARGV[6] == 'delete' then
  redis.call('DEL', KEYS[5])
  redis.call('ZREM', KEYS[3], ARGV[10])
end
if ARGV[5] ~= '' then redis.call('PUBLISH', KEYS[4], ARGV[5]) end
return 1
`

const createRoomScript = `
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', ARGV[1])
if redis.call('EXISTS', KEYS[1]) == 1 then return 1 end
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[2]) then return 2 end
if redis.call('ZCARD', KEYS[3]) >= tonumber(ARGV[3]) then return 3 end
redis.call('SET', KEYS[1], ARGV[4], 'PXAT', ARGV[5])
redis.call('ZADD', KEYS[2], ARGV[5], ARGV[6])
redis.call('ZADD', KEYS[3], ARGV[5], ARGV[6])
redis.call('PEXPIREAT', KEYS[3], ARGV[5])
redis.call('SET', KEYS[4], ARGV[7], 'PX', ARGV[8])
redis.call('ZADD', KEYS[5], ARGV[9], ARGV[10])
return 0
`

const touchSessionScript = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if redis.call('GET', KEYS[2]) ~= ARGV[2] then return 0 end
redis.call('PEXPIRE', KEYS[2], ARGV[3])
redis.call('ZADD', KEYS[3], ARGV[4], ARGV[5])
return 1
`

const disconnectSessionScript = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4])
return 1
`

const authorizePublishScript = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if redis.call('GET', KEYS[2]) ~= ARGV[2] then return -1 end
if ARGV[3] ~= '' and redis.call('GET', KEYS[3]) ~= ARGV[3] then return -2 end
redis.call('PUBLISH', KEYS[4], ARGV[4])
return 1
`

const createRateScript = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
if current > tonumber(ARGV[2]) then return 0 end
return 1
`

const challengeRateScript = `
local pair = redis.call('INCR', KEYS[1])
if pair == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local room = redis.call('INCR', KEYS[2])
if room == 1 then redis.call('PEXPIRE', KEYS[2], ARGV[1]) end
if pair > tonumber(ARGV[2]) or room > tonumber(ARGV[3]) then return 0 end
return 1
`

const canAdmitScript = `
local pair = tonumber(redis.call('GET', KEYS[1]) or '0')
local room = tonumber(redis.call('GET', KEYS[2]) or '0')
if pair >= tonumber(ARGV[1]) or room >= tonumber(ARGV[2]) then return 0 end
return 1
`

const recordAdmissionFailureScript = `
local pair = redis.call('INCR', KEYS[1])
if pair == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local room = redis.call('INCR', KEYS[2])
if room == 1 then redis.call('PEXPIRE', KEYS[2], ARGV[1]) end
return 1
`

const registerConnectionScript = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[3]) then return 0 end
redis.call('SET', KEYS[3], ARGV[4], 'PX', ARGV[5])
redis.call('ZADD', KEYS[1], ARGV[6], ARGV[4])
redis.call('ZADD', KEYS[2], ARGV[6], ARGV[4])
redis.call('PEXPIRE', KEYS[2], ARGV[5])
return 1
`

const refreshConnectionScript = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
redis.call('ZADD', KEYS[3], ARGV[3], ARGV[1])
redis.call('PEXPIRE', KEYS[3], ARGV[2])
return 1
`

const removeConnectionScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
return 1
`

const claimExpiredRoomScript = `
local score = redis.call('ZSCORE', KEYS[2], ARGV[1])
if not score or tonumber(score) > tonumber(ARGV[2]) then return 0 end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('PUBLISH', KEYS[3], ARGV[3])
return 1
`

func New(cfg config.Config) (*Store, error) {
	options, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		return nil, errors.New("parse Redis URL")
	}
	options.MaxRetries = 2
	options.DialTimeout = 5 * time.Second
	options.ReadTimeout = 3 * time.Second
	options.WriteTimeout = 3 * time.Second
	subscriberOptions := *options
	subscriberOptions.PoolSize = 2
	base := cfg.RedisKeyPrefix + ":{veilink:v1}"
	return &Store{
		client:            redis.NewClient(options),
		subscriber:        redis.NewClient(&subscriberOptions),
		base:              base,
		channel:           base + ":events",
		roomTTL:           cfg.RoomTTL,
		maxRooms:          cfg.MaxRooms,
		maxMembers:        cfg.MaxMembers,
		maxRoomsPerIP:     cfg.MaxRoomsPerIP,
		createRate:        cfg.RoomCreateAttemptsPerMinute,
		maxConnections:    cfg.MaxConnections,
		maxConnectionsIP:  cfg.MaxConnectionsPerIP,
		heartbeatInterval: cfg.HeartbeatInterval,
		disconnectGrace:   cfg.DisconnectGrace,
		challengeTTL:      cfg.ChallengeTTL,
		ipHashSecret:      []byte(cfg.StateHMACSecret),
		events:            make(chan Event, 256),
	}, nil
}

func (s *Store) Connect(ctx context.Context) error {
	if err := s.client.Ping(ctx).Err(); err != nil {
		return fmt.Errorf("connect Redis: %w", err)
	}
	s.pubsub = s.subscriber.Subscribe(ctx, s.channel)
	if _, err := s.pubsub.Receive(ctx); err != nil {
		return fmt.Errorf("subscribe Redis events: %w", err)
	}
	s.healthy.Store(true)
	go s.consumeEvents(s.pubsub.Channel())
	return nil
}

func (s *Store) Close() error {
	var closeErr error
	s.closeOnce.Do(func() {
		s.healthy.Store(false)
		if s.pubsub != nil {
			closeErr = s.pubsub.Close()
		}
		if err := s.subscriber.Close(); closeErr == nil {
			closeErr = err
		}
		if err := s.client.Close(); closeErr == nil {
			closeErr = err
		}
	})
	return closeErr
}

func (s *Store) Events() <-chan Event { return s.events }

func (s *Store) Healthy(ctx context.Context) bool {
	if !s.healthy.Load() {
		return false
	}
	if err := s.client.Ping(ctx).Err(); err != nil {
		s.healthy.Store(false)
		return false
	}
	return true
}

func (s *Store) consumeEvents(messages <-chan *redis.Message) {
	for message := range messages {
		for _, event := range parseInternalEnvelope(message.Payload) {
			select {
			case s.events <- event:
			default:
				s.healthy.Store(false)
			}
		}
	}
	s.healthy.Store(false)
}

func parseInternalEnvelope(raw string) []Event {
	var envelope internalEnvelope
	if err := decodeStrict([]byte(raw), &envelope); err != nil || envelope.V != 1 || len(envelope.Events) > 16 {
		return nil
	}
	result := make([]Event, 0, len(envelope.Events))
	for _, item := range envelope.Events {
		var header struct {
			Kind string `json:"kind"`
		}
		if err := json.Unmarshal(item, &header); err != nil {
			continue
		}
		switch header.Kind {
		case "wire":
			var event WireEvent
			if decodeStrict(item, &event) == nil && validInternalWire(event) {
				result = append(result, Event{Wire: &event})
			}
		case "session-replaced":
			var event SessionReplacedEvent
			if decodeStrict(item, &event) == nil && protocol.ValidToken(event.RoomID, 16) && protocol.ValidToken(event.MemberID, 16) && protocol.ValidToken(event.SessionID, 16) {
				result = append(result, Event{SessionReplaced: &event})
			}
		}
	}
	return result
}

func validInternalWire(event WireEvent) bool {
	if event.Kind != "wire" || !protocol.ValidToken(event.RoomID, 16) || event.Event.V != protocol.Version || event.Event.RoomID != "" || event.Event.RequestID != "" {
		return false
	}
	allowedType := map[string]bool{
		"room.member.joined": true,
		"room.member.left":   true,
		"room.owner.changed": true,
		"room.snapshot":      true,
		"room.ended":         true,
		"rtc.description":    true,
		"rtc.candidate":      true,
	}[event.Event.Type]
	if !allowedType {
		return false
	}
	if event.ExcludedMemberID != "" && !protocol.ValidToken(event.ExcludedMemberID, 16) {
		return false
	}
	if event.TargetMemberID != "" && !protocol.ValidToken(event.TargetMemberID, 16) {
		return false
	}
	return event.TargetSessionID == "" || protocol.ValidToken(event.TargetSessionID, 16)
}

func (s *Store) ConsumeRoomCreateAttempt(ctx context.Context, publicIP string) (bool, error) {
	result, err := s.client.Eval(ctx, createRateScript, []string{s.base + ":rate:create:" + s.ipHash(publicIP)}, 60000, s.createRate).Int64()
	return result == 1, err
}

func (s *Store) CreateRoom(ctx context.Context, roomID string, admissionKey []byte, nickname, identityKey, transportID, publicIP string) (Session, error) {
	now, err := s.now(ctx)
	if err != nil {
		return Session{}, err
	}
	member, resumeToken, err := newMember(nickname, identityKey, transportID, now)
	if err != nil {
		return Session{}, err
	}
	ownerID := member.ID
	room := storedRoom{SchemaVersion: 1, ID: roomID, AdmissionKey: base64.RawURLEncoding.EncodeToString(admissionKey), SnapshotVersion: 0, OwnerID: &ownerID, CreatorIPHash: s.ipHash(publicIP), CreatedAt: now, ExpiresAt: now + s.roomTTL.Milliseconds(), Members: []storedMember{member}}
	serialized, err := encodeRoom(room)
	if err != nil {
		return Session{}, err
	}
	leaseTTL := s.activeLeaseTTL()
	result, err := s.client.Eval(ctx, createRoomScript, []string{s.roomKey(roomID), s.roomsKey(), s.creatorKey(room.CreatorIPHash), s.leaseKey(roomID, member.ID), s.leasesKey()}, now, s.maxRooms, s.maxRoomsPerIP, serialized, room.ExpiresAt, roomID, member.SessionID, leaseTTL.Milliseconds(), now+leaseTTL.Milliseconds(), s.leaseRef(roomID, member.ID)).Int64()
	if err != nil {
		return Session{}, err
	}
	switch result {
	case 1:
		return Session{}, &StoreError{ErrRoomExists}
	case 2:
		return Session{}, &StoreError{ErrServerCapacity}
	case 3:
		return Session{}, &StoreError{ErrRateLimited}
	}
	return newSession(room, member, resumeToken, now)
}

func (s *Store) IssueChallenge(ctx context.Context, roomID, transportID, publicIP, nickname, identityKey string) (Challenge, error) {
	if loaded, err := s.loadRoomOptional(ctx, roomID); err != nil || loaded == nil {
		if err != nil {
			return Challenge{}, err
		}
		return Challenge{}, &StoreError{ErrRoomNotFound}
	}
	ipHash := s.ipHash(publicIP)
	issued, err := s.consumeChallengeAttempt(ctx, roomID, ipHash)
	if err != nil {
		return Challenge{}, err
	}
	if !issued {
		return Challenge{}, &StoreError{ErrRateLimited}
	}
	allowed, err := s.canAttemptAdmission(ctx, roomID, ipHash)
	if err != nil || !allowed {
		if err != nil {
			return Challenge{}, err
		}
		return Challenge{}, &StoreError{ErrRateLimited}
	}
	now, err := s.now(ctx)
	if err != nil {
		return Challenge{}, err
	}
	id, err := randomID(16)
	if err != nil {
		return Challenge{}, err
	}
	nonce, err := randomID(32)
	if err != nil {
		return Challenge{}, err
	}
	challenge := storedChallenge{ID: id, Nonce: nonce, RoomID: roomID, TransportID: transportID, PublicIPHash: ipHash, Nickname: nickname, IdentityPublicKey: identityKey, ExpiresAt: now + s.challengeTTL.Milliseconds()}
	raw, err := json.Marshal(challenge)
	if err != nil {
		return Challenge{}, err
	}
	created, err := s.client.SetArgs(ctx, s.challengeKey(id), raw, redis.SetArgs{Mode: "NX", TTL: s.challengeTTL}).Result()
	if err != nil || created != "OK" {
		if err != nil {
			return Challenge{}, err
		}
		return Challenge{}, &StoreError{ErrRateLimited}
	}
	return Challenge{ID: id, Nonce: nonce, ExpiresAt: challenge.ExpiresAt}, nil
}

func (s *Store) ConsumeChallenge(ctx context.Context, roomID, challengeID, proof, transportID, publicIP, nickname, identityKey string) error {
	ipHash := s.ipHash(publicIP)
	allowed, err := s.canAttemptAdmission(ctx, roomID, ipHash)
	if err != nil {
		return err
	}
	if !allowed {
		return &StoreError{ErrRateLimited}
	}
	raw, err := s.client.GetDel(ctx, s.challengeKey(challengeID)).Result()
	if errors.Is(err, redis.Nil) {
		_ = s.recordAdmissionFailure(ctx, roomID, ipHash)
		return &StoreError{ErrChallengeRejected}
	}
	if err != nil {
		return err
	}
	var challenge storedChallenge
	if err := decodeStrict([]byte(raw), &challenge); err != nil {
		return fmt.Errorf("invalid challenge record: %w", err)
	}
	if !validChallenge(challenge) {
		return errors.New("invalid challenge record")
	}
	now, err := s.now(ctx)
	if err != nil {
		return err
	}
	if challenge.ExpiresAt <= now || challenge.RoomID != roomID || challenge.TransportID != transportID || challenge.PublicIPHash != ipHash || challenge.Nickname != nickname || challenge.IdentityPublicKey != identityKey {
		_ = s.recordAdmissionFailure(ctx, roomID, ipHash)
		return &StoreError{ErrChallengeRejected}
	}
	loaded, err := s.loadRoom(ctx, roomID)
	if err != nil {
		return err
	}
	key, err := base64.RawURLEncoding.DecodeString(loaded.room.AdmissionKey)
	if err != nil || len(key) != 32 {
		return errors.New("invalid stored admission key")
	}
	proofBytes, err := base64.RawURLEncoding.DecodeString(proof)
	message := strings.Join([]string{"veilink/v1/admission-proof", roomID, challengeID, challenge.Nonce}, "\x00")
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(message))
	verified := err == nil && len(proofBytes) == sha256.Size && hmac.Equal(mac.Sum(nil), proofBytes)
	for index := range key {
		key[index] = 0
	}
	if !verified {
		_ = s.recordAdmissionFailure(ctx, roomID, ipHash)
		return &StoreError{ErrAdmissionFailed}
	}
	return nil
}

func (s *Store) JoinRoom(ctx context.Context, roomID, nickname, identityKey, transportID string) (Session, error) {
	for attempt := 0; attempt < 12; attempt++ {
		now, err := s.now(ctx)
		if err != nil {
			return Session{}, err
		}
		loaded, err := s.loadRoom(ctx, roomID)
		if err != nil {
			return Session{}, err
		}
		if len(loaded.room.Members) >= s.maxMembers {
			return Session{}, &StoreError{ErrRoomCapacity}
		}
		for _, current := range loaded.room.Members {
			if current.SessionID == transportID {
				return Session{}, &StoreError{ErrAlreadyInRoom}
			}
		}
		member, resumeToken, err := newMember(nickname, identityKey, transportID, now)
		if err != nil {
			return Session{}, err
		}
		wasVacant := len(loaded.room.Members) == 0
		loaded.room.Members = append(loaded.room.Members, member)
		if wasVacant {
			loaded.room.OwnerID = &member.ID
		}
		loaded.room.SnapshotVersion++
		snapshot, err := roomSnapshot(loaded.room, now)
		if err != nil {
			return Session{}, err
		}
		events := []any{
			WireEvent{Kind: "wire", RoomID: roomID, ExcludedMemberID: member.ID, Event: protocol.Frame("room.member.joined", "", "", map[string]any{"member": publicMember(loaded.room, member), "snapshotVersion": loaded.room.SnapshotVersion})},
			WireEvent{Kind: "wire", RoomID: roomID, ExcludedMemberID: member.ID, Event: protocol.Frame("room.snapshot", "", "", snapshot)},
		}
		changed, err := s.casRoom(ctx, loaded, &loaded.room, nil, events, "set", member.ID, member.SessionID, "", now)
		if err != nil {
			return Session{}, err
		}
		if changed {
			return Session{MemberID: member.ID, SessionID: member.SessionID, ResumeToken: resumeToken, Snapshot: snapshot}, nil
		}
	}
	return Session{}, errors.New("Redis room update contention exceeded retry limit")
}

func (s *Store) ResumeRoom(ctx context.Context, roomID, memberID, resumeToken, identityKey, transportID string) (Session, error) {
	for attempt := 0; attempt < 12; attempt++ {
		now, err := s.now(ctx)
		if err != nil {
			return Session{}, err
		}
		loaded, err := s.loadRoom(ctx, roomID)
		if err != nil {
			return Session{}, err
		}
		memberIndex := -1
		for index := range loaded.room.Members {
			if loaded.room.Members[index].ID == memberID {
				memberIndex = index
				break
			}
		}
		suppliedHash := sha256.Sum256([]byte(resumeToken))
		storedHash := make([]byte, sha256.Size)
		if memberIndex >= 0 {
			decoded, decodeErr := hex.DecodeString(loaded.room.Members[memberIndex].ResumeTokenHash)
			if decodeErr == nil && len(decoded) == sha256.Size {
				copy(storedHash, decoded)
			}
		}
		valid := memberIndex >= 0 && loaded.room.Members[memberIndex].IdentityPublicKey == identityKey && hmac.Equal(storedHash, suppliedHash[:])
		if !valid {
			return Session{}, &StoreError{ErrResumeRejected}
		}
		member := &loaded.room.Members[memberIndex]
		previousSessionID := member.SessionID
		member.SessionID = transportID
		rotatedToken, err := randomID(32)
		if err != nil {
			return Session{}, err
		}
		hash := sha256.Sum256([]byte(rotatedToken))
		member.ResumeTokenHash = hex.EncodeToString(hash[:])
		loaded.room.SnapshotVersion++
		snapshot, err := roomSnapshot(loaded.room, now)
		if err != nil {
			return Session{}, err
		}
		events := []any{
			SessionReplacedEvent{Kind: "session-replaced", RoomID: roomID, MemberID: member.ID, SessionID: previousSessionID},
			WireEvent{Kind: "wire", RoomID: roomID, ExcludedMemberID: member.ID, Event: protocol.Frame("room.snapshot", "", "", snapshot)},
		}
		changed, err := s.casRoom(ctx, loaded, &loaded.room, nil, events, "set", member.ID, member.SessionID, previousSessionID, now)
		if err != nil {
			return Session{}, err
		}
		if changed {
			return Session{MemberID: member.ID, SessionID: member.SessionID, ResumeToken: rotatedToken, Snapshot: snapshot}, nil
		}
	}
	return Session{}, errors.New("Redis room update contention exceeded retry limit")
}

func (s *Store) Touch(ctx context.Context, roomID, memberID, sessionID string) (*protocol.RoomSnapshot, error) {
	for attempt := 0; attempt < 6; attempt++ {
		now, err := s.now(ctx)
		if err != nil {
			return nil, err
		}
		loaded, err := s.loadRoomOptional(ctx, roomID)
		if err != nil || loaded == nil {
			return nil, err
		}
		valid := false
		for _, member := range loaded.room.Members {
			if member.ID == memberID && member.SessionID == sessionID {
				valid = true
				break
			}
		}
		if !valid {
			return nil, nil
		}
		leaseTTL := s.activeLeaseTTL()
		result, err := s.client.Eval(ctx, touchSessionScript, []string{s.roomKey(roomID), s.leaseKey(roomID, memberID), s.leasesKey()}, loaded.raw, sessionID, leaseTTL.Milliseconds(), now+leaseTTL.Milliseconds(), s.leaseRef(roomID, memberID)).Int64()
		if err != nil {
			return nil, err
		}
		if result == 1 {
			snapshot, err := roomSnapshot(loaded.room, now)
			return &snapshot, err
		}
	}
	return nil, nil
}

func (s *Store) Disconnect(ctx context.Context, roomID, memberID, sessionID string) error {
	now, err := s.now(ctx)
	if err != nil {
		return err
	}
	return s.client.Eval(ctx, disconnectSessionScript, []string{s.leaseKey(roomID, memberID), s.leasesKey()}, sessionID, s.disconnectGrace.Milliseconds(), now+s.disconnectGrace.Milliseconds(), s.leaseRef(roomID, memberID)).Err()
}

func (s *Store) Leave(ctx context.Context, roomID, memberID, sessionID string) error {
	return s.removeMember(ctx, roomID, memberID, sessionID, "left", true)
}

func (s *Store) Destroy(ctx context.Context, roomID, memberID, sessionID string) error {
	for attempt := 0; attempt < 12; attempt++ {
		loaded, err := s.loadRoom(ctx, roomID)
		if err != nil {
			return err
		}
		found := false
		for _, member := range loaded.room.Members {
			found = found || (member.ID == memberID && member.SessionID == sessionID)
		}
		if !found {
			return &StoreError{ErrMemberNotFound}
		}
		if loaded.room.OwnerID == nil || *loaded.room.OwnerID != memberID {
			return &StoreError{ErrNotOwner}
		}
		now, err := s.now(ctx)
		if err != nil {
			return err
		}
		events := []any{WireEvent{Kind: "wire", RoomID: roomID, Event: protocol.Frame("room.ended", "", "", map[string]string{"reason": "destroyed-by-owner"})}}
		changed, err := s.casRoom(ctx, loaded, nil, &loaded.room, events, "delete", memberID, sessionID, "", now)
		if err != nil {
			return err
		}
		if changed {
			return nil
		}
	}
	return errors.New("Redis room update contention exceeded retry limit")
}

func (s *Store) ForwardRTC(ctx context.Context, roomID, senderID, sessionID, targetID, eventType string, data any) error {
	for attempt := 0; attempt < 6; attempt++ {
		loaded, err := s.loadRoom(ctx, roomID)
		if err != nil {
			return err
		}
		var sender, target *storedMember
		for index := range loaded.room.Members {
			member := &loaded.room.Members[index]
			if member.ID == senderID {
				sender = member
			}
			if member.ID == targetID {
				target = member
			}
		}
		if sender == nil || sender.SessionID != sessionID {
			return &StoreError{ErrMemberNotFound}
		}
		if target == nil {
			return &StoreError{ErrTargetNotFound}
		}
		payload := map[string]any{"fromMemberId": senderID}
		if eventType == "rtc.description" {
			payload["description"] = data
		} else {
			payload["candidate"] = data
		}
		event := WireEvent{Kind: "wire", RoomID: roomID, TargetMemberID: target.ID, TargetSessionID: target.SessionID, Event: protocol.Frame(eventType, "", "", payload)}
		envelope, err := encodeEvents([]any{event})
		if err != nil {
			return err
		}
		result, err := s.client.Eval(ctx, authorizePublishScript, []string{s.roomKey(roomID), s.leaseKey(roomID, sender.ID), s.leaseKey(roomID, target.ID), s.channel}, loaded.raw, sender.SessionID, target.SessionID, envelope).Int64()
		if err != nil {
			return err
		}
		switch result {
		case 1:
			return nil
		case -1:
			return &StoreError{ErrMemberNotFound}
		case -2:
			return &StoreError{ErrTargetNotFound}
		}
	}
	return errors.New("Redis room authorization contention exceeded retry limit")
}

func (s *Store) RegisterConnection(ctx context.Context, connectionID, publicIP string) (bool, error) {
	now, err := s.now(ctx)
	if err != nil {
		return false, err
	}
	ttl := s.activeLeaseTTL()
	result, err := s.client.Eval(ctx, registerConnectionScript, []string{s.connectionsKey(), s.connectionsByIPKey(s.ipHash(publicIP)), s.connectionKey(connectionID)}, now, s.maxConnections, s.maxConnectionsIP, connectionID, ttl.Milliseconds(), now+ttl.Milliseconds()).Int64()
	return result == 1, err
}

func (s *Store) RefreshConnection(ctx context.Context, connectionID, publicIP string) (bool, error) {
	now, err := s.now(ctx)
	if err != nil {
		return false, err
	}
	ttl := s.activeLeaseTTL()
	result, err := s.client.Eval(ctx, refreshConnectionScript, []string{s.connectionKey(connectionID), s.connectionsKey(), s.connectionsByIPKey(s.ipHash(publicIP))}, connectionID, ttl.Milliseconds(), now+ttl.Milliseconds()).Int64()
	return result == 1, err
}

func (s *Store) RemoveConnection(ctx context.Context, connectionID, publicIP string) error {
	return s.client.Eval(ctx, removeConnectionScript, []string{s.connectionKey(connectionID), s.connectionsKey(), s.connectionsByIPKey(s.ipHash(publicIP))}, connectionID).Err()
}

func (s *Store) Sweep(ctx context.Context) error {
	now, err := s.now(ctx)
	if err != nil {
		return err
	}
	expiredRooms, err := s.client.ZRangeByScore(ctx, s.roomsKey(), &redis.ZRangeBy{Min: "0", Max: strconv.FormatInt(now, 10), Offset: 0, Count: 100}).Result()
	if err != nil {
		return err
	}
	for _, roomID := range expiredRooms {
		event := WireEvent{Kind: "wire", RoomID: roomID, Event: protocol.Frame("room.ended", "", "", map[string]string{"reason": "expired"})}
		envelope, _ := encodeEvents([]any{event})
		if err := s.client.Eval(ctx, claimExpiredRoomScript, []string{s.roomKey(roomID), s.roomsKey(), s.channel}, roomID, now, envelope).Err(); err != nil {
			return err
		}
	}
	expiredLeases, err := s.client.ZRangeByScore(ctx, s.leasesKey(), &redis.ZRangeBy{Min: "0", Max: strconv.FormatInt(now, 10), Offset: 0, Count: 200}).Result()
	if err != nil {
		return err
	}
	for _, reference := range expiredLeases {
		parts := strings.Split(reference, ".")
		if len(parts) != 2 || !protocol.ValidToken(parts[0], 16) || !protocol.ValidToken(parts[1], 16) {
			_ = s.client.ZRem(ctx, s.leasesKey(), reference).Err()
			continue
		}
		exists, err := s.client.Exists(ctx, s.leaseKey(parts[0], parts[1])).Result()
		if err != nil {
			return err
		}
		if exists == 1 {
			continue
		}
		if err := s.removeMember(ctx, parts[0], parts[1], "", "disconnected", false); err != nil {
			if !IsCode(err, ErrRoomNotFound) {
				return err
			}
			if err := s.client.ZRem(ctx, s.leasesKey(), reference).Err(); err != nil {
				return err
			}
		}
	}
	return nil
}

type loadedRoom struct {
	raw  string
	room storedRoom
}

func (s *Store) removeMember(ctx context.Context, roomID, memberID, requiredSessionID, reason string, requireLease bool) error {
	for attempt := 0; attempt < 12; attempt++ {
		now, err := s.now(ctx)
		if err != nil {
			return err
		}
		loaded, err := s.loadRoom(ctx, roomID)
		if err != nil {
			return err
		}
		memberIndex := -1
		for index := range loaded.room.Members {
			if loaded.room.Members[index].ID == memberID {
				memberIndex = index
				break
			}
		}
		if memberIndex < 0 {
			_ = s.client.ZRem(ctx, s.leasesKey(), s.leaseRef(roomID, memberID)).Err()
			return nil
		}
		member := loaded.room.Members[memberIndex]
		if requiredSessionID != "" && member.SessionID != requiredSessionID {
			return &StoreError{ErrMemberNotFound}
		}
		lease, leaseErr := s.client.Get(ctx, s.leaseKey(roomID, memberID)).Result()
		if !requireLease && leaseErr == nil {
			return nil
		}
		if requireLease && (leaseErr != nil || lease != member.SessionID) {
			return &StoreError{ErrMemberNotFound}
		}
		ownerChanged := loaded.room.OwnerID != nil && *loaded.room.OwnerID == memberID
		loaded.room.Members = append(loaded.room.Members[:memberIndex], loaded.room.Members[memberIndex+1:]...)
		if len(loaded.room.Members) == 0 {
			loaded.room.OwnerID = nil
		} else if ownerChanged {
			sort.Slice(loaded.room.Members, func(left, right int) bool {
				if loaded.room.Members[left].JoinedAt == loaded.room.Members[right].JoinedAt {
					return loaded.room.Members[left].ID < loaded.room.Members[right].ID
				}
				return loaded.room.Members[left].JoinedAt < loaded.room.Members[right].JoinedAt
			})
			owner := loaded.room.Members[0].ID
			loaded.room.OwnerID = &owner
		}
		loaded.room.SnapshotVersion++
		events := make([]any, 0, 3)
		if len(loaded.room.Members) > 0 {
			events = append(events, WireEvent{Kind: "wire", RoomID: roomID, Event: protocol.Frame("room.member.left", "", "", map[string]any{"memberId": memberID, "reason": reason, "snapshotVersion": loaded.room.SnapshotVersion})})
			if ownerChanged && loaded.room.OwnerID != nil {
				events = append(events, WireEvent{Kind: "wire", RoomID: roomID, Event: protocol.Frame("room.owner.changed", "", "", map[string]any{"ownerId": *loaded.room.OwnerID, "snapshotVersion": loaded.room.SnapshotVersion})})
			}
			snapshot, err := roomSnapshot(loaded.room, now)
			if err != nil {
				return err
			}
			events = append(events, WireEvent{Kind: "wire", RoomID: roomID, Event: protocol.Frame("room.snapshot", "", "", snapshot)})
		}
		changed, err := s.casRoom(ctx, loaded, &loaded.room, nil, events, "delete", memberID, member.SessionID, "", now)
		if err != nil {
			return err
		}
		if changed {
			return nil
		}
	}
	return errors.New("Redis room update contention exceeded retry limit")
}

func (s *Store) casRoom(ctx context.Context, loaded *loadedRoom, room, deletedRoom *storedRoom, events []any, leaseAction, leaseMemberID, leaseSessionID, requiredLeaseSessionID string, now int64) (bool, error) {
	source := room
	if source == nil {
		source = deletedRoom
	}
	if source == nil {
		return false, errors.New("CAS room source is required")
	}
	serialized := ""
	if room != nil {
		var err error
		serialized, err = encodeRoom(*room)
		if err != nil {
			return false, err
		}
	}
	eventJSON := ""
	if len(events) > 0 {
		var err error
		eventJSON, err = encodeEvents(events)
		if err != nil {
			return false, err
		}
	}
	if leaseMemberID == "" {
		leaseMemberID = "_"
	}
	leaseTTL := s.activeLeaseTTL()
	deleted := "0"
	if room == nil {
		deleted = "1"
	}
	result, err := s.client.Eval(ctx, casRoomScript, []string{s.roomKey(source.ID), s.roomsKey(), s.leasesKey(), s.channel, s.leaseKey(source.ID, leaseMemberID), s.creatorKey(source.CreatorIPHash)}, loaded.raw, serialized, source.ExpiresAt, source.ID, eventJSON, leaseAction, leaseSessionID, leaseTTL.Milliseconds(), now+leaseTTL.Milliseconds(), s.leaseRef(source.ID, leaseMemberID), source.CreatorIPHash, deleted, requiredLeaseSessionID).Int64()
	if err != nil {
		return false, err
	}
	if result == -1 {
		return false, &StoreError{ErrResumeRejected}
	}
	return result == 1, nil
}

func (s *Store) loadRoom(ctx context.Context, roomID string) (*loadedRoom, error) {
	loaded, err := s.loadRoomOptional(ctx, roomID)
	if err != nil {
		return nil, err
	}
	if loaded == nil {
		return nil, &StoreError{ErrRoomNotFound}
	}
	return loaded, nil
}

func (s *Store) loadRoomOptional(ctx context.Context, roomID string) (*loadedRoom, error) {
	raw, err := s.client.Get(ctx, s.roomKey(roomID)).Result()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var room storedRoom
	if err := decodeStrict([]byte(raw), &room); err != nil || !validRoom(room, roomID, s.maxMembers) {
		return nil, errors.New("invalid Redis room record")
	}
	return &loadedRoom{raw: raw, room: room}, nil
}

func validRoom(room storedRoom, expectedID string, maxMembers int) bool {
	if room.SchemaVersion != 1 || room.ID != expectedID || !protocol.ValidToken(room.ID, 16) || len(room.Members) > maxMembers || room.CreatedAt < 0 || room.ExpiresAt <= room.CreatedAt || room.SnapshotVersion < 0 {
		return false
	}
	admissionKey, err := base64.RawURLEncoding.DecodeString(room.AdmissionKey)
	if err != nil || len(admissionKey) != 32 || !protocol.ValidToken(room.CreatorIPHash, 32) {
		return false
	}
	seen := make(map[string]struct{}, len(room.Members))
	ownerFound := room.OwnerID == nil
	for _, member := range room.Members {
		nickname, nicknameErr := protocol.NormalizeNickname(member.Nickname)
		if !protocol.ValidToken(member.ID, 16) || !protocol.ValidToken(member.IdentityPublicKey, 32) || !protocol.ValidToken(member.SessionID, 16) || nicknameErr != nil || nickname != member.Nickname || member.JoinedAt < 0 || len(member.ResumeTokenHash) != 64 {
			return false
		}
		if _, err := hex.DecodeString(member.ResumeTokenHash); err != nil {
			return false
		}
		if _, exists := seen[member.ID]; exists {
			return false
		}
		seen[member.ID] = struct{}{}
		ownerFound = ownerFound || (room.OwnerID != nil && member.ID == *room.OwnerID)
	}
	return ownerFound && ((len(room.Members) == 0 && room.OwnerID == nil) || (len(room.Members) > 0 && room.OwnerID != nil))
}

func validChallenge(challenge storedChallenge) bool {
	nickname, err := protocol.NormalizeNickname(challenge.Nickname)
	return protocol.ValidToken(challenge.ID, 16) &&
		protocol.ValidToken(challenge.Nonce, 32) &&
		protocol.ValidToken(challenge.RoomID, 16) &&
		protocol.ValidToken(challenge.TransportID, 16) &&
		protocol.ValidToken(challenge.PublicIPHash, 32) &&
		protocol.ValidToken(challenge.IdentityPublicKey, 32) &&
		err == nil && nickname == challenge.Nickname && challenge.ExpiresAt > 0
}

func newMember(nickname, identityKey, transportID string, now int64) (storedMember, string, error) {
	memberID, err := randomID(16)
	if err != nil {
		return storedMember{}, "", err
	}
	resumeToken, err := randomID(32)
	if err != nil {
		return storedMember{}, "", err
	}
	hash := sha256.Sum256([]byte(resumeToken))
	return storedMember{ID: memberID, Nickname: nickname, IdentityPublicKey: identityKey, JoinedAt: now, ResumeTokenHash: hex.EncodeToString(hash[:]), SessionID: transportID}, resumeToken, nil
}

func newSession(room storedRoom, member storedMember, resumeToken string, now int64) (Session, error) {
	snapshot, err := roomSnapshot(room, now)
	return Session{MemberID: member.ID, SessionID: member.SessionID, ResumeToken: resumeToken, Snapshot: snapshot}, err
}

func roomSnapshot(room storedRoom, now int64) (protocol.RoomSnapshot, error) {
	if room.OwnerID == nil || len(room.Members) == 0 {
		return protocol.RoomSnapshot{}, errors.New("cannot snapshot a vacant room")
	}
	members := make([]protocol.PublicMember, 0, len(room.Members))
	for _, member := range room.Members {
		members = append(members, publicMember(room, member))
	}
	return protocol.Snapshot(room.ID, room.SnapshotVersion, *room.OwnerID, members, room.CreatedAt, room.ExpiresAt, now), nil
}

func publicMember(room storedRoom, member storedMember) protocol.PublicMember {
	return protocol.PublicMember{MemberID: member.ID, Nickname: member.Nickname, IdentityPublicKey: member.IdentityPublicKey, JoinedAt: member.JoinedAt, IsOwner: room.OwnerID != nil && *room.OwnerID == member.ID}
}

func (s *Store) canAttemptAdmission(ctx context.Context, roomID, ipHash string) (bool, error) {
	result, err := s.client.Eval(ctx, canAdmitScript, []string{s.admissionPairKey(roomID, ipHash), s.admissionRoomKey(roomID)}, 5, 30).Int64()
	return result == 1, err
}

func (s *Store) consumeChallengeAttempt(ctx context.Context, roomID, ipHash string) (bool, error) {
	result, err := s.client.Eval(
		ctx,
		challengeRateScript,
		[]string{s.base + ":rate:challenge:" + roomID + ":" + ipHash, s.base + ":rate:challenge:" + roomID},
		(1 * time.Minute).Milliseconds(),
		12,
		240,
	).Int64()
	return result == 1, err
}

func (s *Store) recordAdmissionFailure(ctx context.Context, roomID, ipHash string) error {
	return s.client.Eval(ctx, recordAdmissionFailureScript, []string{s.admissionPairKey(roomID, ipHash), s.admissionRoomKey(roomID)}, (10 * time.Minute).Milliseconds()).Err()
}

func (s *Store) now(ctx context.Context) (int64, error) {
	value, err := s.client.Time(ctx).Result()
	if err != nil {
		return 0, err
	}
	return value.UnixMilli(), nil
}

func (s *Store) activeLeaseTTL() time.Duration { return s.disconnectGrace + s.heartbeatInterval }

func (s *Store) ipHash(publicIP string) string {
	mac := hmac.New(sha256.New, s.ipHashSecret)
	_, _ = mac.Write([]byte("veilink-redis-ip\x00"))
	_, _ = mac.Write([]byte(publicIP))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func randomID(size int) (string, error) {
	value := make([]byte, size)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func decodeStrict(raw []byte, output any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("unexpected trailing JSON")
	}
	return nil
}

func encodeRoom(room storedRoom) (string, error) {
	encoded, err := json.Marshal(room)
	return string(encoded), err
}

func encodeEvents(events []any) (string, error) {
	encoded, err := json.Marshal(eventEnvelope{V: 1, Events: events})
	return string(encoded), err
}

func (s *Store) roomKey(roomID string) string  { return s.base + ":room:" + roomID }
func (s *Store) roomsKey() string              { return s.base + ":rooms" }
func (s *Store) creatorKey(hash string) string { return s.base + ":creator:" + hash }
func (s *Store) leaseKey(roomID, memberID string) string {
	return s.base + ":lease:" + roomID + ":" + memberID
}
func (s *Store) leaseRef(roomID, memberID string) string { return roomID + "." + memberID }
func (s *Store) leasesKey() string                       { return s.base + ":leases" }
func (s *Store) challengeKey(challengeID string) string  { return s.base + ":challenge:" + challengeID }
func (s *Store) admissionPairKey(roomID, hash string) string {
	return s.base + ":rate:admission:" + roomID + ":" + hash
}
func (s *Store) admissionRoomKey(roomID string) string { return s.base + ":rate:admission:" + roomID }
func (s *Store) connectionsKey() string                { return s.base + ":connections" }
func (s *Store) connectionsByIPKey(hash string) string { return s.base + ":connections:ip:" + hash }
func (s *Store) connectionKey(connectionID string) string {
	return s.base + ":connection:" + connectionID
}
