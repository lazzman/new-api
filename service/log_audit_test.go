package service

import (
	"errors"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func newServiceLogAuditTestContext() *gin.Context {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	return c
}

func TestRecordLogAuditDetailAsyncDoesNotWaitForSlowWrite(t *testing.T) {
	c := newServiceLogAuditTestContext()
	c.Set(common.RequestIdKey, "req-async")
	common.StoreLogAuditRequestBody(c, []byte("request"))
	common.StoreLogAuditResponse(c, nil, "stream", []byte("response"))

	oldSubmit := submitLogAuditDetailTask
	oldRecord := recordLogAuditDetail
	t.Cleanup(func() {
		submitLogAuditDetailTask = oldSubmit
		recordLogAuditDetail = oldRecord
	})

	started := make(chan struct{})
	release := make(chan struct{})
	done := make(chan struct{})
	submitLogAuditDetailTask = func(task func()) {
		go func() {
			task()
			close(done)
		}()
	}
	recordLogAuditDetail = func(detail *model.LogAuditDetail) error {
		close(started)
		<-release
		return nil
	}

	start := time.Now()
	RecordLogAuditDetailAsync(c, &relaycommon.RelayInfo{UserId: 7}, 42)
	require.Less(t, time.Since(start), 50*time.Millisecond)

	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("后台审计写入未启动")
	}

	close(release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("后台审计写入未结束")
	}
}

func TestRecordLogAuditDetailAsyncUsesSnapshotWithoutGinContext(t *testing.T) {
	c := newServiceLogAuditTestContext()
	c.Set(common.RequestIdKey, "req-before")
	common.StoreLogAuditRequestBody(c, []byte("request-before"))
	common.StoreLogAuditResponse(c, nil, "stream", []byte("response-before"))

	oldSubmit := submitLogAuditDetailTask
	oldRecord := recordLogAuditDetail
	t.Cleanup(func() {
		submitLogAuditDetailTask = oldSubmit
		recordLogAuditDetail = oldRecord
	})

	var task func()
	var recorded *model.LogAuditDetail
	submitLogAuditDetailTask = func(f func()) {
		task = f
	}
	recordLogAuditDetail = func(detail *model.LogAuditDetail) error {
		recorded = detail
		return nil
	}

	RecordLogAuditDetailAsync(c, &relaycommon.RelayInfo{UserId: 7}, 42)
	require.NotNil(t, task)

	c.Set(common.RequestIdKey, "req-after")
	common.StoreLogAuditRequestBody(c, []byte("request-after"))
	common.StoreLogAuditResponse(c, nil, "stream", []byte("response-after"))

	task()
	require.NotNil(t, recorded)
	require.Equal(t, 42, recorded.LogId)
	require.Equal(t, 7, recorded.UserId)
	require.Equal(t, "req-before", recorded.RequestId)

	var payload common.LogAuditPayload
	require.NoError(t, common.Unmarshal([]byte(recorded.Payload), &payload))
	require.Equal(t, "request-before", payload.Request.Raw)
	require.Equal(t, len("request-before"), payload.Request.Bytes)
	require.False(t, payload.Request.Truncated)
	require.Equal(t, "response-before", payload.Response.Raw)
	require.Equal(t, len("response-before"), payload.Response.Bytes)
	require.False(t, payload.Response.Truncated)
}

func TestRecordLogAuditDetailAsyncIgnoresBackgroundWriteFailure(t *testing.T) {
	testCases := []struct {
		name   string
		record func(*model.LogAuditDetail) error
	}{
		{
			name: "error",
			record: func(detail *model.LogAuditDetail) error {
				return errors.New("db unavailable")
			},
		},
		{
			name: "panic",
			record: func(detail *model.LogAuditDetail) error {
				panic("db panic")
			},
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			c := newServiceLogAuditTestContext()
			c.Set(common.RequestIdKey, "req-failure")
			common.StoreLogAuditRequestBody(c, []byte("request"))
			common.StoreLogAuditResponse(c, nil, "stream", []byte("response"))

			oldSubmit := submitLogAuditDetailTask
			oldRecord := recordLogAuditDetail
			t.Cleanup(func() {
				submitLogAuditDetailTask = oldSubmit
				recordLogAuditDetail = oldRecord
			})

			var task func()
			submitLogAuditDetailTask = func(f func()) {
				task = f
			}
			recordLogAuditDetail = tc.record

			require.NotPanics(t, func() {
				RecordLogAuditDetailAsync(c, &relaycommon.RelayInfo{UserId: 7}, 42)
			})
			require.NotNil(t, task)
			require.NotPanics(t, task)
		})
	}
}
