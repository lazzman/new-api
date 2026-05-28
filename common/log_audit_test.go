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
