package common

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
)

const (
	LogAuditPayloadVersion = 1

	logAuditContextKey = "log_audit_context"
)

type LogAuditPayload struct {
	Version  int              `json:"version"`
	Source   LogAuditSource   `json:"source"`
	Request  LogAuditMessage  `json:"request"`
	Response LogAuditResponse `json:"response"`
}

type LogAuditSource struct {
	Protocol      string `json:"protocol,omitempty"`
	RequestFormat string `json:"request_format,omitempty"`
	RelayFormat   string `json:"relay_format,omitempty"`
	ChannelId     int    `json:"channel_id,omitempty"`
	ChannelType   int    `json:"channel_type,omitempty"`
	ApiType       int    `json:"api_type,omitempty"`
	Endpoint      string `json:"endpoint,omitempty"`
	UpstreamURL   string `json:"upstream_url,omitempty"`
	OriginalModel string `json:"original_model,omitempty"`
	UpstreamModel string `json:"upstream_model,omitempty"`
	Stream        bool   `json:"stream"`
}

type LogAuditMessage struct {
	Headers   map[string][]string `json:"headers,omitempty"`
	Raw       string              `json:"raw,omitempty"`
	Bytes     int                 `json:"bytes"`
	Truncated bool                `json:"truncated"`
}

type LogAuditResponse struct {
	Headers   map[string][]string `json:"headers,omitempty"`
	Type      string              `json:"type,omitempty"`
	Raw       string              `json:"raw,omitempty"`
	Bytes     int                 `json:"bytes"`
	Truncated bool                `json:"truncated"`
}

type logAuditContext struct {
	payload LogAuditPayload
}

func getExistingLogAuditContext(c *gin.Context) *logAuditContext {
	if c == nil {
		return nil
	}
	if value, ok := c.Get(logAuditContextKey); ok {
		if auditCtx, ok := value.(*logAuditContext); ok {
			return auditCtx
		}
	}
	return nil
}

func getLogAuditContext(c *gin.Context) *logAuditContext {
	if c == nil {
		return nil
	}
	if auditCtx := getExistingLogAuditContext(c); auditCtx != nil {
		return auditCtx
	}
	auditCtx := &logAuditContext{
		payload: LogAuditPayload{
			Version: LogAuditPayloadVersion,
		},
	}
	c.Set(logAuditContextKey, auditCtx)
	return auditCtx
}

func StoreLogAuditSource(c *gin.Context, source LogAuditSource) {
	auditCtx := getLogAuditContext(c)
	if auditCtx == nil {
		return
	}
	auditCtx.payload.Source = source
}

func StoreLogAuditUpstreamURL(c *gin.Context, upstreamURL string) {
	auditCtx := getLogAuditContext(c)
	if auditCtx == nil {
		return
	}
	auditCtx.payload.Source.UpstreamURL = upstreamURL
}

func StoreLogAuditRequestHeaders(c *gin.Context, headers http.Header) {
	auditCtx := getLogAuditContext(c)
	if auditCtx == nil {
		return
	}
	auditCtx.payload.Request.Headers = sanitizeHeaders(headers)
}

func StoreLogAuditRequestBody(c *gin.Context, raw []byte) {
	auditCtx := getLogAuditContext(c)
	if auditCtx == nil {
		return
	}
	auditCtx.payload.Request.Raw = string(raw)
	auditCtx.payload.Request.Bytes = len(raw)
	auditCtx.payload.Request.Truncated = false
}

func StoreLogAuditResponse(c *gin.Context, headers http.Header, responseType string, raw []byte) {
	auditCtx := getLogAuditContext(c)
	if auditCtx == nil {
		return
	}
	auditCtx.payload.Response.Headers = sanitizeHeaders(headers)
	auditCtx.payload.Response.Type = responseType
	auditCtx.payload.Response.Raw = string(raw)
	auditCtx.payload.Response.Bytes = len(raw)
	auditCtx.payload.Response.Truncated = false
}

func StoreLogAuditResponseParts(c *gin.Context, headers http.Header, responseType string, raw string, bytes int, truncated bool) {
	auditCtx := getLogAuditContext(c)
	if auditCtx == nil {
		return
	}
	auditCtx.payload.Response.Headers = sanitizeHeaders(headers)
	auditCtx.payload.Response.Type = responseType
	auditCtx.payload.Response.Raw = raw
	auditCtx.payload.Response.Bytes = bytes
	auditCtx.payload.Response.Truncated = truncated
}

func StoreLogAuditResponseAndResetBody(c *gin.Context, resp *http.Response) error {
	if resp == nil || resp.Body == nil {
		return nil
	}
	responseBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if isAuditTextLikeContentType(resp.Header.Get("Content-Type")) {
		StoreLogAuditResponse(c, resp.Header, "json", responseBody)
	} else {
		StoreLogAuditResponseParts(c, resp.Header, "binary", "", len(responseBody), false)
	}
	resp.Body = io.NopCloser(bytes.NewReader(responseBody))
	return nil
}

func StoreLogAuditRequestBodyIfTextLike(c *gin.Context, raw []byte) {
	if isAuditTextLikeContentType(c.GetHeader("Content-Type")) {
		StoreLogAuditRequestBody(c, raw)
	}
}

func BuildLogAuditPayload(c *gin.Context) (string, bool, error) {
	payload, ok := SnapshotLogAuditPayload(c)
	if !ok {
		return "", false, nil
	}
	return BuildLogAuditPayloadFromSnapshot(payload)
}

func SnapshotLogAuditPayload(c *gin.Context) (LogAuditPayload, bool) {
	auditCtx := getExistingLogAuditContext(c)
	if auditCtx == nil {
		return LogAuditPayload{}, false
	}
	payload := cloneLogAuditPayload(auditCtx.payload)
	if payload.Version == 0 {
		payload.Version = LogAuditPayloadVersion
	}
	if !hasLogAuditPayload(payload) {
		return LogAuditPayload{}, false
	}
	return payload, true
}

func BuildLogAuditPayloadFromSnapshot(payload LogAuditPayload) (string, bool, error) {
	if payload.Version == 0 {
		payload.Version = LogAuditPayloadVersion
	}
	if !hasLogAuditPayload(payload) {
		return "", false, nil
	}
	data, err := Marshal(payload)
	if err != nil {
		return "", false, err
	}
	return string(data), true, nil
}

func cloneLogAuditPayload(payload LogAuditPayload) LogAuditPayload {
	payload.Request.Headers = cloneLogAuditHeaders(payload.Request.Headers)
	payload.Response.Headers = cloneLogAuditHeaders(payload.Response.Headers)
	return payload
}

func cloneLogAuditHeaders(headers map[string][]string) map[string][]string {
	if len(headers) == 0 {
		return nil
	}
	copied := make(map[string][]string, len(headers))
	for key, values := range headers {
		copied[key] = append([]string(nil), values...)
	}
	return copied
}

func hasLogAuditPayload(payload LogAuditPayload) bool {
	return payload.Request.Raw != "" ||
		len(payload.Request.Headers) > 0 ||
		payload.Response.Raw != "" ||
		len(payload.Response.Headers) > 0
}

func sanitizeHeaders(headers http.Header) map[string][]string {
	if len(headers) == 0 {
		return nil
	}
	result := make(map[string][]string, len(headers))
	keys := make([]string, 0, len(headers))
	for key := range headers {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		values := headers.Values(key)
		copied := make([]string, 0, len(values))
		for _, value := range values {
			if isSensitiveHeader(key) {
				copied = append(copied, redactHeaderValue(value))
			} else {
				copied = append(copied, value)
			}
		}
		result[http.CanonicalHeaderKey(key)] = copied
	}
	return result
}

func isSensitiveHeader(name string) bool {
	lower := strings.ToLower(strings.TrimSpace(name))
	if lower == "" {
		return false
	}
	switch lower {
	case "authorization", "proxy-authorization", "api-key", "x-api-key",
		"openai-api-key", "cookie", "set-cookie", "x-auth-token", "x-goog-api-key":
		return true
	}
	return strings.Contains(lower, "token") ||
		strings.Contains(lower, "secret") ||
		strings.Contains(lower, "credential") ||
		strings.Contains(lower, "api-key")
}

func redactHeaderValue(value string) string {
	sum := sha256.Sum256([]byte(value))
	return fmt.Sprintf("[REDACTED len=%d sha256=%x]", len(value), sum[:6])
}

func isAuditTextLikeContentType(contentType string) bool {
	normalized := strings.ToLower(contentType)
	return normalized == "" ||
		strings.Contains(normalized, "json") ||
		strings.Contains(normalized, "text") ||
		strings.Contains(normalized, "x-www-form-urlencoded")
}
