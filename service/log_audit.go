package service

import (
	"context"
	"fmt"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"

	"github.com/bytedance/gopkg/util/gopool"
	"github.com/gin-gonic/gin"
)

var (
	submitLogAuditDetailTask = gopool.Go
	recordLogAuditDetail     = model.RecordLogAuditDetail
)

type logAuditDetailSnapshot struct {
	LogId     int
	UserId    int
	CreatedAt int64
	RequestId string
	Payload   common.LogAuditPayload
}

func StoreRelayLogAuditSource(c *gin.Context, info *relaycommon.RelayInfo) {
	if c == nil || info == nil {
		return
	}
	source := common.LogAuditSource{
		Protocol:      string(info.GetFinalRequestRelayFormat()),
		RequestFormat: string(info.GetFinalRequestRelayFormat()),
		RelayFormat:   string(info.RelayFormat),
		Endpoint:      info.RequestURLPath,
		OriginalModel: info.OriginModelName,
		UpstreamModel: info.UpstreamModelName,
		Stream:        info.IsStream,
	}
	if info.ChannelMeta != nil {
		source.ChannelId = info.ChannelId
		source.ChannelType = info.ChannelType
		source.ApiType = info.ApiType
	}
	common.StoreLogAuditSource(c, source)
}

func RecordLogAuditDetail(c *gin.Context, relayInfo *relaycommon.RelayInfo, logId int) {
	snapshot, ok, err := buildLogAuditDetailSnapshot(c, relayInfo, logId)
	if err != nil {
		logger.LogError(c, "failed to build log audit snapshot: "+err.Error())
		return
	}
	if !ok {
		return
	}
	if err := recordLogAuditDetailSnapshot(snapshot); err != nil {
		logger.LogError(c, "failed to record log audit detail: "+err.Error())
	}
}

func RecordLogAuditDetailAsync(c *gin.Context, relayInfo *relaycommon.RelayInfo, logId int) {
	snapshot, ok, err := buildLogAuditDetailSnapshot(c, relayInfo, logId)
	if err != nil {
		logger.LogError(c, "failed to build log audit snapshot: "+err.Error())
		return
	}
	if !ok {
		return
	}

	submitLogAuditDetailTask(func() {
		defer func() {
			if r := recover(); r != nil {
				logLogAuditBackgroundError(snapshot, fmt.Sprintf("panic recording log audit detail: %v", r))
			}
		}()
		if err := recordLogAuditDetailSnapshot(snapshot); err != nil {
			logLogAuditBackgroundError(snapshot, "failed to record log audit detail: "+err.Error())
		}
	})
}

func buildLogAuditDetailSnapshot(c *gin.Context, relayInfo *relaycommon.RelayInfo, logId int) (*logAuditDetailSnapshot, bool, error) {
	if c == nil || relayInfo == nil || logId == 0 {
		return nil, false, nil
	}
	payload, ok := common.SnapshotLogAuditPayload(c)
	if !ok {
		return nil, false, nil
	}
	return &logAuditDetailSnapshot{
		LogId:     logId,
		UserId:    relayInfo.UserId,
		CreatedAt: common.GetTimestamp(),
		RequestId: c.GetString(common.RequestIdKey),
		Payload:   payload,
	}, true, nil
}

func recordLogAuditDetailSnapshot(snapshot *logAuditDetailSnapshot) error {
	if snapshot == nil || snapshot.LogId == 0 {
		return nil
	}
	payload, ok, err := common.BuildLogAuditPayloadFromSnapshot(snapshot.Payload)
	if err != nil {
		return err
	}
	if !ok {
		return nil
	}
	return recordLogAuditDetail(&model.LogAuditDetail{
		LogId:     snapshot.LogId,
		UserId:    snapshot.UserId,
		CreatedAt: snapshot.CreatedAt,
		RequestId: snapshot.RequestId,
		Payload:   model.LogAuditPayloadText(payload),
	})
}

func logLogAuditBackgroundError(snapshot *logAuditDetailSnapshot, message string) {
	ctx := context.Background()
	if snapshot != nil && snapshot.RequestId != "" {
		ctx = context.WithValue(ctx, common.RequestIdKey, snapshot.RequestId)
	}
	if snapshot != nil {
		message = fmt.Sprintf("%s, log_id=%d, user_id=%d", message, snapshot.LogId, snapshot.UserId)
	}
	logger.LogError(ctx, message)
}
