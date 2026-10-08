package storage

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
)

// ConfigInUse 检查账号全部排队任务是否引用要删除的配置。
//
// 参数：agentID 指定私聊成员，roomIDs 指定其所在群或单个待修改群。
// 返回值：任一未结束任务引用这些配置时为 true。
// 注意事项：调用时已经持有账号锁；不使用只返回前 100 条的领取列表。
func (t *memTx) ConfigInUse(_ context.Context, agentID string, roomIDs []string) (bool, error) {
	for _, item := range t.memory.dispatches {
		if item.AccountID != t.accountID || item.Status != "pending" && item.Status != "running" {
			continue
		}
		if slices.Contains(roomIDs, item.RoomID) {
			return true, nil
		}
		if agentID == "" || item.RoomID != "" {
			continue
		}
		var payload struct {
			AgentID    string `json:"agentId"`
			Responders []struct {
				AgentID string `json:"agentId"`
			} `json:"responders"`
		}
		if err := json.Unmarshal(item.Payload, &payload); err != nil {
			return false, err
		}
		if payload.AgentID == agentID {
			return true, nil
		}
		for _, responder := range payload.Responders {
			if responder.AgentID == agentID {
				return true, nil
			}
		}
	}
	return false, nil
}

// ConfigInUse 使用账号和任务状态索引检查全部队列中的配置引用。
//
// 参数：agentID 指定私聊成员，roomIDs 指定需要保护的群。
// 返回值：SQL EXISTS 返回是否仍被 pending 或 running 任务引用。
// 注意事项：私聊兼容旧 responders 格式；全部参数绑定，不拼接用户输入或加载任务正文。
func (t *mysqlTx) ConfigInUse(ctx context.Context, agentID string, roomIDs []string) (bool, error) {
	conditions := []string{}
	arguments := []any{t.accountID}
	if len(roomIDs) > 0 {
		conditions = append(conditions, "room_id IN ("+strings.TrimSuffix(strings.Repeat("?,", len(roomIDs)), ",")+")")
		for _, id := range roomIDs {
			arguments = append(arguments, id)
		}
	}
	if agentID != "" {
		conditions = append(conditions, `(room_id='' AND (JSON_UNQUOTE(JSON_EXTRACT(payload,'$.agentId'))=? OR JSON_CONTAINS(JSON_EXTRACT(payload,'$.responders[*].agentId'), JSON_QUOTE(?))))`)
		arguments = append(arguments, agentID, agentID)
	}
	if len(conditions) == 0 {
		return false, nil
	}
	var busy bool
	err := t.tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM dispatches WHERE account_id=? AND status IN ('pending','running') AND (`+strings.Join(conditions, " OR ")+`))`, arguments...).Scan(&busy)
	return busy, err
}
