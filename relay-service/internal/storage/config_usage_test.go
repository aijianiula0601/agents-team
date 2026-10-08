package storage

import (
	"context"
	"fmt"
	"testing"
)

// TestConfigInUseChecksEntireAccountQueue 验证配置使用检查不受 100 条任务分页影响。
//
// 参数：t 为测试句柄。
// 返回值：无；账号隔离、状态筛选、群或旧私聊格式错误时失败。
// 注意事项：直接使用独立内存事务，不连接真实数据库或依赖任务领取顺序。
func TestConfigInUseChecksEntireAccountQueue(t *testing.T) {
	memory := NewMemory()
	tx := &memTx{memory: memory, accountID: "owned"}
	for index := 0; index < 101; index++ {
		id := fmt.Sprintf("queued-%d", index)
		memory.dispatches[id] = Dispatch{ID: id, AccountID: "owned", Status: "pending", Payload: []byte(`{"agentId":"other"}`)}
	}
	memory.dispatches["target"] = Dispatch{ID: "target", AccountID: "owned", Status: "running", Payload: []byte(`{"agentId":"target"}`)}
	busy, err := tx.ConfigInUse(context.Background(), "target", nil)
	if err != nil || !busy {
		t.Fatal("超过 100 个排队任务后的私聊引用遗漏")
	}
	for _, item := range []Dispatch{
		{ID: "target", AccountID: "owned", Status: "pending", RoomID: "room-target", Payload: []byte(`{}`)},
		{ID: "target", AccountID: "owned", Status: "pending", Payload: []byte(`{"responders":[{"agentId":"target"}]}`)},
	} {
		memory.dispatches["target"] = item
		busy, err = tx.ConfigInUse(context.Background(), "target", []string{"room-target"})
		if err != nil || !busy {
			t.Fatal("群引用或旧私聊 responders 未识别")
		}
	}
	for _, item := range []Dispatch{
		{ID: "target", AccountID: "other", Status: "running", Payload: []byte(`{"agentId":"target"}`)},
		{ID: "target", AccountID: "owned", Status: "done", Payload: []byte(`{"agentId":"target"}`)},
		{ID: "target", AccountID: "owned", Status: "failed", Payload: []byte(`{"agentId":"target"}`)},
		{ID: "target", AccountID: "owned", Status: "pending", RoomID: "unrelated-room", Payload: []byte(`{"responders":[{"agentId":"target"}]}`)},
	} {
		memory.dispatches["target"] = item
		busy, err = tx.ConfigInUse(context.Background(), "target", []string{"room-target"})
		if err != nil || busy {
			t.Fatal("其他账号、终态或未关联群任务阻止合法配置操作")
		}
	}
}
