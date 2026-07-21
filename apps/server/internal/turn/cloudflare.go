package turn

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/OVINC-CN/Veilink/apps/server/internal/protocol"
)

const maxResponseBytes = 64 * 1024

var allowedURLs = map[string]bool{
	"turn:turn.cloudflare.com:3478?transport=udp":  true,
	"turn:turn.cloudflare.com:3478?transport=tcp":  true,
	"turn:turn.cloudflare.com:80?transport=tcp":    true,
	"turns:turn.cloudflare.com:5349?transport=tcp": true,
	"turns:turn.cloudflare.com:443?transport=tcp":  true,
}

type Client struct {
	keyID      string
	apiToken   string
	ttl        time.Duration
	httpClient *http.Client
}

type cloudflareResponse struct {
	ICEServers []cloudflareICEServer `json:"iceServers"`
}

type cloudflareICEServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username"`
	Credential string   `json:"credential"`
}

func New(keyID, apiToken string, ttl time.Duration) *Client {
	return &Client{
		keyID:    keyID,
		apiToken: apiToken,
		ttl:      ttl,
		httpClient: &http.Client{
			Timeout: 5 * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

func (c *Client) Generate(ctx context.Context) (protocol.TURNCredentialsPayload, error) {
	body, err := json.Marshal(map[string]int64{"ttl": int64(c.ttl / time.Second)})
	if err != nil {
		return protocol.TURNCredentialsPayload{}, errors.New("encode Cloudflare TURN request")
	}
	endpoint := "https://rtc.live.cloudflare.com/v1/turn/keys/" + c.keyID + "/credentials/generate-ice-servers"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return protocol.TURNCredentialsPayload{}, errors.New("create Cloudflare TURN request")
	}
	request.Header.Set("Authorization", "Bearer "+c.apiToken)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")

	response, err := c.httpClient.Do(request)
	if err != nil {
		return protocol.TURNCredentialsPayload{}, fmt.Errorf("request Cloudflare TURN credentials: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxResponseBytes))
		return protocol.TURNCredentialsPayload{}, fmt.Errorf("Cloudflare TURN credentials returned status %d", response.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil || len(raw) > maxResponseBytes {
		return protocol.TURNCredentialsPayload{}, errors.New("read Cloudflare TURN credentials")
	}
	var decoded cloudflareResponse
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return protocol.TURNCredentialsPayload{}, errors.New("decode Cloudflare TURN credentials")
	}
	iceServers := make([]protocol.TURNICEServer, 0, len(decoded.ICEServers))
	for _, server := range decoded.ICEServers {
		if server.Username == "" || len(server.Username) > 256 || server.Credential == "" || len(server.Credential) > 512 {
			continue
		}
		urls := make([]string, 0, len(server.URLs))
		for _, candidate := range server.URLs {
			if allowedURLs[candidate] {
				urls = append(urls, candidate)
			}
		}
		if len(urls) == 0 || len(urls) > 8 {
			continue
		}
		iceServers = append(iceServers, protocol.TURNICEServer{
			URLs:           urls,
			Username:       server.Username,
			Credential:     server.Credential,
			CredentialType: "password",
		})
	}
	if len(iceServers) == 0 || len(iceServers) > 4 {
		return protocol.TURNCredentialsPayload{}, errors.New("Cloudflare returned no supported TURN servers")
	}
	return protocol.TURNCredentialsPayload{
		ICEServers: iceServers,
		ExpiresAt:  time.Now().Add(c.ttl).UnixMilli(),
	}, nil
}
