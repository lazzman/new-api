package model

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/schema"
)

func TestLogAuditPayloadTextUsesLargeTextForMySQL(t *testing.T) {
	payload := LogAuditPayloadText("")

	require.Equal(t, "LONGTEXT", payload.GormDBDataType(&gorm.DB{
		Config: &gorm.Config{Dialector: mysql.Open("user:pass@tcp(localhost:3306)/db")},
	}, nil))
	require.Equal(t, "TEXT", payload.GormDBDataType(&gorm.DB{
		Config: &gorm.Config{Dialector: postgres.Open("host=localhost user=user dbname=db")},
	}, nil))
	require.Equal(t, "TEXT", payload.GormDBDataType(&gorm.DB{
		Config: &gorm.Config{Dialector: sqlite.Open(":memory:")},
	}, nil))
}

func TestRecordLogAuditDetailStoresLargePayload(t *testing.T) {
	truncateTables(t)

	largePayload := strings.Repeat(
		"x",
		2<<20,
	)
	err := RecordLogAuditDetail(&LogAuditDetail{
		LogId:   99001,
		UserId:  1,
		Payload: LogAuditPayloadText(largePayload),
	})
	require.NoError(t, err)

	detail, err := GetLogAuditDetail(99001)
	require.NoError(t, err)
	require.Len(t, string(detail.Payload), len(largePayload))
}

func TestLogAuditDetailLargePayloadDatabaseMatrix(t *testing.T) {
	payload := LogAuditPayloadText(strings.Repeat("x", 2<<20))
	for _, tc := range []struct {
		name string
		env  string
		open func(string) gorm.Dialector
	}{
		{name: "sqlite", open: func(string) gorm.Dialector { return sqlite.Open(":memory:") }},
		{name: "mysql", env: "AUDIT_MYSQL_DSN", open: mysql.Open},
		{name: "postgres", env: "AUDIT_POSTGRES_DSN", open: postgres.Open},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dsn := os.Getenv(tc.env)
			if tc.env != "" && dsn == "" {
				t.Skip(tc.env + " is not configured")
			}
			db, err := gorm.Open(tc.open(dsn), &gorm.Config{
				NamingStrategy: schema.NamingStrategy{
					TablePrefix: fmt.Sprintf("lad_%s_%d_", tc.name, time.Now().UnixNano()),
				},
			})
			require.NoError(t, err)
			t.Cleanup(func() {
				require.NoError(t, db.Migrator().DropTable(&LogAuditDetail{}))
			})

			require.NoError(t, db.AutoMigrate(&LogAuditDetail{}))
			// 连续迁移必须保留同一跨库大文本列定义。
			require.NoError(t, db.AutoMigrate(&LogAuditDetail{}))

			detail := &LogAuditDetail{LogId: 99003, UserId: 1, Payload: payload}
			require.NoError(t, db.Create(detail).Error)

			var stored LogAuditDetail
			require.NoError(t, db.Where("log_id = ?", detail.LogId).First(&stored).Error)
			require.Equal(t, string(payload), string(stored.Payload))
		})
	}
}

func TestClickHouseLogAuditOperationsAreDisabled(t *testing.T) {
	originalType := common.LogDatabaseType()
	common.SetLogDatabaseType(common.DatabaseTypeClickHouse)
	t.Cleanup(func() {
		common.SetLogDatabaseType(originalType)
	})

	require.NoError(t, RecordLogAuditDetail(&LogAuditDetail{
		LogId:   99002,
		UserId:  1,
		Payload: LogAuditPayloadText(`{"version":1}`),
	}))

	detail, err := GetLogAuditDetail(99002)
	require.Nil(t, detail)
	require.ErrorIs(t, err, gorm.ErrRecordNotFound)

	detail, err = GetUserLogAuditDetail(1, 99002)
	require.Nil(t, detail)
	require.ErrorIs(t, err, gorm.ErrRecordNotFound)

	logs := []*Log{{Id: 42}}
	require.NoError(t, attachLogAuditAvailability(logs))
	require.Zero(t, logs[0].LogId)
	require.False(t, logs[0].HasAudit)
}

func TestDeleteOldLogBatchDeletesAuditDetailsWithRelationalLogs(t *testing.T) {
	truncateTables(t)

	oldLog := &Log{CreatedAt: time.Now().Add(-2 * time.Hour).Unix(), RequestId: "old-log"}
	newLog := &Log{CreatedAt: time.Now().Unix(), RequestId: "new-log"}
	require.NoError(t, LOG_DB.Create(oldLog).Error)
	require.NoError(t, LOG_DB.Create(newLog).Error)
	require.NoError(t, LOG_DB.Create(&LogAuditDetail{
		LogId:   oldLog.Id,
		UserId:  1,
		Payload: LogAuditPayloadText(`{"old":true}`),
	}).Error)
	require.NoError(t, LOG_DB.Create(&LogAuditDetail{
		LogId:   newLog.Id,
		UserId:  1,
		Payload: LogAuditPayloadText(`{"new":true}`),
	}).Error)

	deleted, err := DeleteOldLogBatch(context.Background(), time.Now().Add(-time.Hour).Unix(), 100)
	require.NoError(t, err)
	require.EqualValues(t, 1, deleted)

	var oldLogCount int64
	require.NoError(t, LOG_DB.Model(&Log{}).Where("id = ?", oldLog.Id).Count(&oldLogCount).Error)
	require.Zero(t, oldLogCount)

	var oldAuditCount int64
	require.NoError(t, LOG_DB.Model(&LogAuditDetail{}).Where("log_id = ?", oldLog.Id).Count(&oldAuditCount).Error)
	require.Zero(t, oldAuditCount)

	var newLogCount int64
	require.NoError(t, LOG_DB.Model(&Log{}).Where("id = ?", newLog.Id).Count(&newLogCount).Error)
	require.EqualValues(t, 1, newLogCount)

	var newAuditCount int64
	require.NoError(t, LOG_DB.Model(&LogAuditDetail{}).Where("log_id = ?", newLog.Id).Count(&newAuditCount).Error)
	require.EqualValues(t, 1, newAuditCount)
}
