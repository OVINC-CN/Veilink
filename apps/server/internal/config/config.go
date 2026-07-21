package config

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const MaxRoomTTL = 24 * time.Hour

type Config struct {
	Host                         string
	Port                         int
	AppOrigin                    string
	TLSCertFile                  string
	TLSKeyFile                   string
	RedisURL                     string
	RedisKeyPrefix               string
	StateHMACSecret              string
	CloudflareTURNKeyID          string
	CloudflareTURNAPIToken       string
	TURNCredentialTTL            time.Duration
	RoomCreationPasswordHash     [sha256.Size]byte
	RoomCreationPasswordRequired bool
	RoomTTL                      time.Duration
	MaxRooms                     int
	MaxConnections               int
	MaxConnectionsPerIP          int
	MaxRoomsPerIP                int
	RoomCreateAttemptsPerMinute  int
	MaxMembers                   int
	HeartbeatInterval            time.Duration
	DisconnectGrace              time.Duration
	PeerConnectionTimeout        time.Duration
	ChallengeTTL                 time.Duration
	TrustedProxyNets             []*net.IPNet
	StaticRoot                   string
}

func Load() (Config, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return Config{}, fmt.Errorf("resolve working directory: %w", err)
	}
	staticRoot := strings.TrimSpace(os.Getenv("WEB_DIST_DIR"))
	if staticRoot == "" {
		staticRoot = filepath.Clean(filepath.Join(cwd, "..", "web", "dist"))
	}

	port, err := integer("PORT", 3000, 1, 65535)
	if err != nil {
		return Config{}, err
	}
	roomTTLSeconds, err := integer("ROOM_TTL_SECONDS", int(MaxRoomTTL/time.Second), 60, int(MaxRoomTTL/time.Second))
	if err != nil {
		return Config{}, err
	}
	maxRooms, err := integer("MAX_ROOMS", 1000, 1, 100000)
	if err != nil {
		return Config{}, err
	}
	maxConnections, err := integer("MAX_CONNECTIONS", 2048, 1, 100000)
	if err != nil {
		return Config{}, err
	}
	maxConnectionsPerIP, err := integer("MAX_CONNECTIONS_PER_IP", 64, 1, 10000)
	if err != nil {
		return Config{}, err
	}
	maxRoomsPerIP, err := integer("MAX_ROOMS_PER_IP", 32, 1, 10000)
	if err != nil {
		return Config{}, err
	}
	createAttempts, err := integer("ROOM_CREATE_ATTEMPTS_PER_MINUTE", 20, 1, 10000)
	if err != nil {
		return Config{}, err
	}
	reconnectSeconds, err := integer("RECONNECT_GRACE_SECONDS", 30, 5, 900)
	if err != nil {
		return Config{}, err
	}
	peerConnectionTimeoutSeconds, err := integer("PEER_CONNECTION_TIMEOUT_SECONDS", 90, 30, 300)
	if err != nil {
		return Config{}, err
	}
	turnCredentialTTLSeconds, err := integer("TURN_CREDENTIAL_TTL_SECONDS", 25*60*60, 300, 48*60*60)
	if err != nil {
		return Config{}, err
	}

	appOrigin, err := origin(strings.TrimSpace(os.Getenv("APP_ORIGIN")))
	if err != nil {
		return Config{}, err
	}
	redisURL, err := redisURL(strings.TrimSpace(os.Getenv("REDIS_URL")))
	if err != nil {
		return Config{}, err
	}
	trusted, err := trustedProxyNets(strings.TrimSpace(os.Getenv("TRUST_PROXY_CIDRS")))
	if err != nil {
		return Config{}, err
	}

	secret := strings.TrimSpace(os.Getenv("STATE_HMAC_SECRET"))
	if len(secret) < 32 {
		return Config{}, errors.New("STATE_HMAC_SECRET must contain at least 32 characters")
	}
	if secret == "replace-with-64-random-hex-characters-before-deploying" {
		return Config{}, errors.New("STATE_HMAC_SECRET must be replaced before deployment")
	}
	turnKeyID := strings.TrimSpace(os.Getenv("CLOUDFLARE_TURN_KEY_ID"))
	if len(turnKeyID) != 32 || strings.ContainsAny(turnKeyID, " \t\r\n") {
		return Config{}, errors.New("CLOUDFLARE_TURN_KEY_ID must contain exactly 32 non-whitespace characters")
	}
	turnAPIToken := strings.TrimSpace(os.Getenv("CLOUDFLARE_TURN_API_TOKEN"))
	if len(turnAPIToken) < 32 || len(turnAPIToken) > 512 || strings.ContainsAny(turnAPIToken, " \t\r\n") {
		return Config{}, errors.New("CLOUDFLARE_TURN_API_TOKEN must contain 32 to 512 non-whitespace characters")
	}
	creationPassword := os.Getenv("ROOM_CREATION_PASSWORD")
	if !utf8.ValidString(creationPassword) || len(creationPassword) > 256 {
		return Config{}, errors.New("ROOM_CREATION_PASSWORD must be valid UTF-8 and at most 256 bytes")
	}
	creationPasswordRequired := creationPassword != ""
	creationPasswordHash := sha256.Sum256([]byte(creationPassword))
	creationPassword = ""
	_ = os.Unsetenv("ROOM_CREATION_PASSWORD")
	tlsCert := strings.TrimSpace(os.Getenv("TLS_CERT_FILE"))
	tlsKey := strings.TrimSpace(os.Getenv("TLS_KEY_FILE"))
	if (tlsCert == "") != (tlsKey == "") {
		return Config{}, errors.New("TLS_CERT_FILE and TLS_KEY_FILE must be configured together")
	}
	prefix := strings.TrimSpace(os.Getenv("REDIS_KEY_PREFIX"))
	if prefix == "" {
		prefix = "veilink"
	}
	if len(prefix) > 96 || strings.IndexFunc(prefix, func(r rune) bool {
		return !(r >= 'a' && r <= 'z') && !(r >= 'A' && r <= 'Z') && !(r >= '0' && r <= '9') && r != ':' && r != '_' && r != '-'
	}) >= 0 {
		return Config{}, errors.New("REDIS_KEY_PREFIX contains unsupported characters")
	}

	return Config{
		Host:                         envOr("HOST", "0.0.0.0"),
		Port:                         port,
		AppOrigin:                    appOrigin,
		TLSCertFile:                  tlsCert,
		TLSKeyFile:                   tlsKey,
		RedisURL:                     redisURL,
		RedisKeyPrefix:               prefix,
		StateHMACSecret:              secret,
		CloudflareTURNKeyID:          turnKeyID,
		CloudflareTURNAPIToken:       turnAPIToken,
		TURNCredentialTTL:            time.Duration(turnCredentialTTLSeconds) * time.Second,
		RoomCreationPasswordHash:     creationPasswordHash,
		RoomCreationPasswordRequired: creationPasswordRequired,
		RoomTTL:                      time.Duration(roomTTLSeconds) * time.Second,
		MaxRooms:                     maxRooms,
		MaxConnections:               maxConnections,
		MaxConnectionsPerIP:          maxConnectionsPerIP,
		MaxRoomsPerIP:                maxRoomsPerIP,
		RoomCreateAttemptsPerMinute:  createAttempts,
		MaxMembers:                   8,
		HeartbeatInterval:            15 * time.Second,
		DisconnectGrace:              time.Duration(reconnectSeconds) * time.Second,
		PeerConnectionTimeout:        time.Duration(peerConnectionTimeoutSeconds) * time.Second,
		ChallengeTTL:                 30 * time.Second,
		TrustedProxyNets:             trusted,
		StaticRoot:                   staticRoot,
	}, nil
}

func integer(name string, fallback, minimum, maximum int) (int, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < minimum || value > maximum {
		return 0, fmt.Errorf("%s must be between %d and %d", name, minimum, maximum)
	}
	return value, nil
}

func envOr(name, fallback string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	return value
}

func origin(value string) (string, error) {
	if value == "" {
		return "", errors.New("APP_ORIGIN is required")
	}
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("APP_ORIGIN must be an exact HTTP(S) origin without a trailing slash")
	}
	loopback := parsed.Hostname() == "localhost" || parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "::1"
	if parsed.Scheme != "https" && !loopback {
		return "", errors.New("APP_ORIGIN must use HTTPS outside local development")
	}
	return parsed.Scheme + "://" + parsed.Host, nil
}

func redisURL(value string) (string, error) {
	if value == "" {
		return "", errors.New("REDIS_URL is required")
	}
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "redis" && parsed.Scheme != "rediss") || parsed.Hostname() == "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("REDIS_URL must be an absolute redis:// or rediss:// URL without query parameters")
	}
	loopback := parsed.Hostname() == "localhost" || parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "::1"
	password := ""
	hasPassword := false
	if parsed.User != nil {
		password, hasPassword = parsed.User.Password()
	}
	if !loopback && (parsed.User == nil || !hasPassword || password == "") {
		return "", errors.New("REDIS_URL must include authentication outside local development")
	}
	return value, nil
}

func trustedProxyNets(value string) ([]*net.IPNet, error) {
	if value == "" {
		return nil, nil
	}
	entries := strings.Split(value, ",")
	result := make([]*net.IPNet, 0, len(entries))
	for _, entry := range entries {
		candidate := strings.TrimSpace(entry)
		if !strings.Contains(candidate, "/") {
			ip := net.ParseIP(candidate)
			if ip == nil {
				return nil, fmt.Errorf("invalid proxy address: %q", candidate)
			}
			bits := 128
			if ip.To4() != nil {
				bits = 32
			}
			candidate = candidate + "/" + strconv.Itoa(bits)
		}
		_, network, err := net.ParseCIDR(candidate)
		if err != nil {
			return nil, fmt.Errorf("invalid proxy CIDR %q: %w", candidate, err)
		}
		result = append(result, network)
	}
	return result, nil
}
