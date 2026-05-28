package model

import (
	"strings"
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
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
