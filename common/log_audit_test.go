package common

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func newLogAuditTestContext() *gin.Context {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	return c
}

func TestLogAuditPayloadRedactsSensitiveHeaders(t *testing.T) {
	c := newLogAuditTestContext()
	headers := http.Header{}
	headers.Set("Authorization", "Bearer secret-token")
	headers.Set("X-Request-Id", "req_123")

	StoreLogAuditRequestHeaders(c, headers)
	payload, ok, err := BuildLogAuditPayload(c)
	require.NoError(t, err)
	require.True(t, ok)

	var parsed LogAuditPayload
	require.NoError(t, Unmarshal([]byte(payload), &parsed))
	require.Equal(t, "req_123", parsed.Request.Headers["X-Request-Id"][0])
	require.Contains(t, parsed.Request.Headers["Authorization"][0], "[REDACTED")
	require.NotContains(t, payload, "secret-token")
}

func TestLogAuditPayloadStoresCompleteBodies(t *testing.T) {
	c := newLogAuditTestContext()
	requestBody := strings.Repeat("a", 700<<10)
	responseBody := strings.Repeat("b", 2<<20)

	StoreLogAuditRequestBody(c, []byte(requestBody))
	StoreLogAuditResponse(c, nil, "json", []byte(responseBody))
	payload, ok, err := BuildLogAuditPayload(c)
	require.NoError(t, err)
	require.True(t, ok)

	var parsed LogAuditPayload
	require.NoError(t, Unmarshal([]byte(payload), &parsed))
	require.Equal(t, len(requestBody), parsed.Request.Bytes)
	require.Len(t, parsed.Request.Raw, len(requestBody))
	require.False(t, parsed.Request.Truncated)
	require.Equal(t, len(responseBody), parsed.Response.Bytes)
	require.Len(t, parsed.Response.Raw, len(responseBody))
	require.False(t, parsed.Response.Truncated)
}

func TestLogAuditSnapshotCopiesPayload(t *testing.T) {
	c := newLogAuditTestContext()
	headers := http.Header{}
	headers.Add("X-Trace-Id", "trace-1")

	StoreLogAuditRequestHeaders(c, headers)
	StoreLogAuditRequestBody(c, []byte("request-1"))
	StoreLogAuditResponse(c, headers, "stream", []byte("response-1"))

	snapshot, ok := SnapshotLogAuditPayload(c)
	require.True(t, ok)

	headers.Set("X-Trace-Id", "trace-2")
	StoreLogAuditRequestHeaders(c, headers)
	StoreLogAuditRequestBody(c, []byte("request-2"))
	StoreLogAuditResponse(c, headers, "stream", []byte("response-2"))

	require.Equal(t, "trace-1", snapshot.Request.Headers["X-Trace-Id"][0])
	require.Equal(t, "request-1", snapshot.Request.Raw)
	require.Equal(t, len("request-1"), snapshot.Request.Bytes)
	require.False(t, snapshot.Request.Truncated)
	require.Equal(t, "response-1", snapshot.Response.Raw)
	require.Equal(t, len("response-1"), snapshot.Response.Bytes)
	require.False(t, snapshot.Response.Truncated)

	payload, ok, err := BuildLogAuditPayloadFromSnapshot(snapshot)
	require.NoError(t, err)
	require.True(t, ok)
	require.Contains(t, payload, "request-1")
	require.Contains(t, payload, "response-1")
	require.NotContains(t, payload, "request-2")
	require.NotContains(t, payload, "response-2")
}
