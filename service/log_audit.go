package service

import (
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"

	"github.com/gin-gonic/gin"
)

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
	if c == nil || relayInfo == nil || logId == 0 {
		return
	}
	payload, ok, err := common.BuildLogAuditPayload(c)
	if err != nil {
		logger.LogError(c, "failed to build log audit payload: "+err.Error())
		return
	}
	if !ok {
		return
	}
	if err := model.RecordLogAuditDetail(&model.LogAuditDetail{
		LogId:     logId,
		UserId:    relayInfo.UserId,
		CreatedAt: common.GetTimestamp(),
		RequestId: c.GetString(common.RequestIdKey),
		Payload:   model.LogAuditPayloadText(payload),
	}); err != nil {
		logger.LogError(c, "failed to record log audit detail: "+err.Error())
	}
}
