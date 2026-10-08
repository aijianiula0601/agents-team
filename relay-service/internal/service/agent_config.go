package service

import (
	"context"
	"encoding/json"
	"strings"
	"unicode/utf8"

	"agents-team-relay/internal/storage"
)

// UpdateAgentConfig 允许同账号的有效设备编辑已有 Agent 的非敏感配置。
//
// 参数：device 为认证会话；agentID 为目标；baseRevision 为所见快照版本；config 只包含需修改的配置字段。
// 返回值：更新后的完整快照，冲突时返回 409 及当前快照。
// 注意事项：配置属于账号的主电脑执行环境；本接口不能创建 Agent、改消息、发布模型目录或改执行状态。
func (s *Service) UpdateAgentConfig(ctx context.Context, device storage.Device, agentID string, baseRevision int64, config json.RawMessage) (storage.State, error) {
	return s.MutateTeamConfig(ctx, device, TeamConfigMutation{Collection: "agents", Action: "update", ID: agentID, BaseRevision: baseRevision, Config: config})
}

// validateAgentConfig 限定可远程编辑的配置字段并检查字段类型和长度。
//
// 参数：config 为客户端提供的配置对象。
// 返回值：经验证的字段映射；不接受密钥、消息、设备归属和未知字段。
// 注意事项：主电脑路径可远程填写但不能在中转站访问，实际执行仍由主电脑检查。
func validateAgentConfig(config json.RawMessage) (map[string]any, error) {
	patch, err := decodeObject(config)
	if err != nil {
		return nil, err
	}
	if len(patch) == 0 {
		return nil, fail(400, "INVALID", "缺少 Agent 配置")
	}
	for key, value := range patch {
		if key == "temperature" {
			number, ok := value.(json.Number)
			temperature, err := number.Float64()
			if !ok || err != nil || temperature < 0 || temperature > 2 {
				return nil, fail(400, "INVALID", "温度必须是 0 到 2 之间的数字")
			}
			continue
		}
		limit := 2000
		switch key {
		case "name", "initial", "label", "role", "provider", "model", "backend", "harness", "harnessModel", "workspaceMode":
			limit = 200
		case "workspace", "endpoint":
		case "persona":
			limit = 16000
		default:
			return nil, fail(400, "INVALID", "包含不允许修改的 Agent 配置字段")
		}
		text, ok := value.(string)
		if !ok || utf8.RuneCountInString(text) > limit || strings.ContainsRune(text, '\x00') || key == "name" && strings.TrimSpace(text) == "" {
			return nil, fail(400, "INVALID", "Agent 配置字段格式或长度不正确")
		}
		if key == "workspaceMode" && text != "auto" && text != "project" {
			return nil, fail(400, "INVALID", "工作区模式不正确")
		}
		if key == "backend" && text != "model" && text != "codex" && text != "claude" && text != "cursor" {
			return nil, fail(400, "INVALID", "执行后台不正确")
		}
	}
	return patch, nil
}

// configRevision 读取独立的远端配置版本，兼容尚无该字段的旧快照。
//
// 参数：body 为已经验证过的快照 JSON。
// 返回值：非负版本号；缺少或非法字段返回 0。
// 注意事项：版本只能由配置更新接口递增，整份快照上传必须匹配当前版本。
func configRevision(body []byte) int64 {
	var metadata struct {
		Revision int64 `json:"configRevision"`
	}
	if json.Unmarshal(body, &metadata) != nil || metadata.Revision < 0 {
		return 0
	}
	return metadata.Revision
}

// stateConflict 组装当前版本冲突响应，供整份快照和独立配置修改共同使用。
//
// 参数：current 为账号事务内读取的最新快照。
// 返回值：包含可重试版本及独立正文副本的业务错误。
// 注意事项：只在完成账号认证之后返回，不能跨账号泄露快照。
func stateConflict(current storage.State) *Error {
	return &Error{Status: 409, Code: "REVISION_CONFLICT", Message: "聊天或配置版本已变化，请同步后重试", Revision: current.Revision, State: append(json.RawMessage(nil), current.Body...)}
}
