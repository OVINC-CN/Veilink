package protocol

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	Version           = 8
	MaxSignalBytes    = 128 * 1024
	MaxSDPBytes       = 128 * 1024
	MaxCandidateBytes = 4096
	MaxNicknameBytes  = 96
	MaxNicknameRunes  = 24
	MaxMembers        = 8
)

var (
	requestIDPattern     = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)
	candidateTypePattern = regexp.MustCompile(`(?i)(?:^|\s)typ\s+(host|srflx|prflx|relay)(?:\s|$)`)
)

type ClientEnvelope struct {
	V         int             `json:"v"`
	Type      string          `json:"type"`
	RequestID string          `json:"requestId,omitempty"`
	RoomID    string          `json:"roomId"`
	Payload   json.RawMessage `json:"payload"`
}

type PublicMember struct {
	MemberID          string `json:"memberId"`
	Nickname          string `json:"nickname"`
	IdentityPublicKey string `json:"identityPublicKey"`
	JoinedAt          int64  `json:"joinedAt"`
	IsOwner           bool   `json:"isOwner"`
}

type RoomSnapshot struct {
	RoomID          string         `json:"roomId"`
	SnapshotVersion int64          `json:"snapshotVersion"`
	OwnerID         string         `json:"ownerId"`
	Members         []PublicMember `json:"members"`
	CreatedAt       int64          `json:"createdAt"`
	ExpiresAt       int64          `json:"expiresAt"`
	ServerNow       int64          `json:"serverNow"`
}

type SessionConfirmation struct {
	SelfMemberID string       `json:"selfMemberId"`
	ResumeToken  string       `json:"resumeToken"`
	Snapshot     RoomSnapshot `json:"snapshot"`
}

type RoomCreatePayload struct {
	Nickname          string `json:"nickname"`
	AdmissionVerifier string `json:"admissionVerifier"`
	IdentityPublicKey string `json:"identityPublicKey"`
	CreationPassword  string `json:"creationPassword,omitempty"`
}

type RoomChallengePayload struct {
	Nickname          string `json:"nickname"`
	IdentityPublicKey string `json:"identityPublicKey"`
}

type RoomJoinPayload struct {
	Nickname          string `json:"nickname"`
	IdentityPublicKey string `json:"identityPublicKey"`
	ChallengeID       string `json:"challengeId"`
	Proof             string `json:"proof"`
}

type RoomResumePayload struct {
	MemberID          string `json:"memberId"`
	ResumeToken       string `json:"resumeToken"`
	IdentityPublicKey string `json:"identityPublicKey"`
}

type TargetDescriptionPayload struct {
	TargetMemberID string         `json:"targetMemberId"`
	Description    RTCDescription `json:"description"`
}

type TargetCandidatePayload struct {
	TargetMemberID string       `json:"targetMemberId"`
	Candidate      ICECandidate `json:"candidate"`
}

type RTCDescription struct {
	Type string `json:"type"`
	SDP  string `json:"sdp,omitempty"`
}

type ICECandidate struct {
	Candidate        string  `json:"candidate"`
	SDPMid           *string `json:"sdpMid"`
	SDPMLineIndex    *int    `json:"sdpMLineIndex"`
	UsernameFragment *string `json:"usernameFragment,omitempty"`
}

type HeartbeatPayload struct {
	SentAt int64 `json:"sentAt"`
}

type EmptyPayload struct{}

type TURNICEServer struct {
	URLs           []string `json:"urls"`
	Username       string   `json:"username"`
	Credential     string   `json:"credential"`
	CredentialType string   `json:"credentialType"`
}

type TURNCredentialsPayload struct {
	ICEServers []TURNICEServer `json:"iceServers"`
	ExpiresAt  int64           `json:"expiresAt"`
}

type ErrorPayload struct {
	Code         string `json:"code"`
	Message      string `json:"message"`
	RetryAfterMS int64  `json:"retryAfterMs,omitempty"`
}

type WireFrame struct {
	V         int    `json:"v"`
	Type      string `json:"type"`
	RequestID string `json:"requestId,omitempty"`
	RoomID    string `json:"roomId,omitempty"`
	Payload   any    `json:"payload"`
}

func DecodeClient(raw []byte) (ClientEnvelope, error) {
	var envelope ClientEnvelope
	if len(raw) == 0 || len(raw) > MaxSignalBytes {
		return envelope, errors.New("invalid frame size")
	}
	if err := decodeStrict(raw, &envelope); err != nil {
		return envelope, err
	}
	if envelope.V != Version {
		return envelope, errors.New("unsupported version")
	}
	if !ValidToken(envelope.RoomID, 16) {
		return envelope, errors.New("invalid room ID")
	}
	if envelope.RequestID != "" && !requestIDPattern.MatchString(envelope.RequestID) {
		return envelope, errors.New("invalid request ID")
	}
	if len(envelope.Payload) == 0 {
		return envelope, errors.New("missing payload")
	}
	return envelope, nil
}

func DecodePayload[T any](raw json.RawMessage) (T, error) {
	var payload T
	if err := decodeStrict(raw, &payload); err != nil {
		return payload, err
	}
	return payload, nil
}

func decodeStrict(raw []byte, output any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return fmt.Errorf("invalid JSON: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("unexpected trailing JSON")
	}
	return nil
}

func ValidToken(value string, byteLength int) bool {
	if value == "" || strings.Contains(value, "=") {
		return false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil && len(decoded) == byteLength && base64.RawURLEncoding.EncodeToString(decoded) == value
}

func NormalizeNickname(value string) (string, error) {
	if !utf8.ValidString(value) || len(value) > MaxNicknameBytes {
		return "", errors.New("invalid nickname encoding or length")
	}
	for _, character := range value {
		if unicode.IsControl(character) || character == '\u061c' || character == '\u200e' || character == '\u200f' ||
			(character >= '\u202a' && character <= '\u202e') || (character >= '\u2066' && character <= '\u2069') ||
			character == '\u2028' || character == '\u2029' {
			return "", errors.New("nickname contains forbidden controls")
		}
	}
	normalized := strings.Join(strings.Fields(value), " ")
	count := utf8.RuneCountInString(normalized)
	if count < 1 || count > MaxNicknameRunes || len(normalized) > MaxNicknameBytes {
		return "", errors.New("nickname length is invalid")
	}
	return normalized, nil
}

func ValidateCreate(payload RoomCreatePayload) (RoomCreatePayload, error) {
	nickname, err := NormalizeNickname(payload.Nickname)
	if err != nil || !ValidToken(payload.AdmissionVerifier, 32) || !ValidToken(payload.IdentityPublicKey, 32) || !utf8.ValidString(payload.CreationPassword) || len(payload.CreationPassword) > 256 {
		return payload, errors.New("invalid create payload")
	}
	payload.Nickname = nickname
	return payload, nil
}

func ValidateChallenge(payload RoomChallengePayload) (RoomChallengePayload, error) {
	nickname, err := NormalizeNickname(payload.Nickname)
	if err != nil || !ValidToken(payload.IdentityPublicKey, 32) {
		return payload, errors.New("invalid challenge payload")
	}
	payload.Nickname = nickname
	return payload, nil
}

func ValidateJoin(payload RoomJoinPayload) (RoomJoinPayload, error) {
	nickname, err := NormalizeNickname(payload.Nickname)
	if err != nil || !ValidToken(payload.IdentityPublicKey, 32) || !ValidToken(payload.ChallengeID, 16) || !ValidToken(payload.Proof, 32) {
		return payload, errors.New("invalid join payload")
	}
	payload.Nickname = nickname
	return payload, nil
}

func ValidateResume(payload RoomResumePayload) error {
	if !ValidToken(payload.MemberID, 16) || !ValidToken(payload.ResumeToken, 32) || !ValidToken(payload.IdentityPublicKey, 32) {
		return errors.New("invalid resume payload")
	}
	return nil
}

func ValidateDescription(payload TargetDescriptionPayload) error {
	if !ValidToken(payload.TargetMemberID, 16) {
		return errors.New("invalid target")
	}
	if payload.Description.Type != "offer" && payload.Description.Type != "answer" && payload.Description.Type != "pranswer" && payload.Description.Type != "rollback" {
		return errors.New("invalid SDP type")
	}
	if payload.Description.Type != "rollback" && (payload.Description.SDP == "" || len(payload.Description.SDP) > MaxSDPBytes) {
		return errors.New("invalid SDP")
	}
	for _, line := range strings.Split(payload.Description.SDP, "\n") {
		candidate := strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		if strings.HasPrefix(candidate, "a=candidate:") && !RelayCandidate(strings.TrimPrefix(candidate, "a=")) {
			return errors.New("non-relay ICE candidate")
		}
	}
	return nil
}

func ValidateCandidate(payload TargetCandidatePayload) error {
	if !ValidToken(payload.TargetMemberID, 16) || len(payload.Candidate.Candidate) > MaxCandidateBytes || !RelayCandidate(payload.Candidate.Candidate) {
		return errors.New("invalid or non-relay ICE candidate")
	}
	if payload.Candidate.SDPMid != nil && len(*payload.Candidate.SDPMid) > 256 {
		return errors.New("invalid SDP mid")
	}
	if payload.Candidate.SDPMLineIndex != nil && (*payload.Candidate.SDPMLineIndex < 0 || *payload.Candidate.SDPMLineIndex > 65535) {
		return errors.New("invalid SDP line index")
	}
	if payload.Candidate.UsernameFragment != nil && len(*payload.Candidate.UsernameFragment) > 256 {
		return errors.New("invalid username fragment")
	}
	return nil
}

func RelayCandidate(candidate string) bool {
	if candidate == "" {
		return true
	}
	if strings.ContainsAny(candidate, "\x00\r\n") {
		return false
	}
	matches := candidateTypePattern.FindAllStringSubmatch(candidate, -1)
	return len(matches) == 1 && len(matches[0]) == 2 && strings.EqualFold(matches[0][1], "relay")
}

func Snapshot(roomID string, version int64, ownerID string, members []PublicMember, createdAt, expiresAt, now int64) RoomSnapshot {
	copyMembers := append([]PublicMember(nil), members...)
	sort.Slice(copyMembers, func(left, right int) bool {
		if copyMembers[left].JoinedAt == copyMembers[right].JoinedAt {
			return copyMembers[left].MemberID < copyMembers[right].MemberID
		}
		return copyMembers[left].JoinedAt < copyMembers[right].JoinedAt
	})
	return RoomSnapshot{RoomID: roomID, SnapshotVersion: version, OwnerID: ownerID, Members: copyMembers, CreatedAt: createdAt, ExpiresAt: expiresAt, ServerNow: now}
}

func Frame(frameType, roomID, requestID string, payload any) WireFrame {
	return WireFrame{V: Version, Type: frameType, RoomID: roomID, RequestID: requestID, Payload: payload}
}
