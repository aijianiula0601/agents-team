package service

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"agents-team-relay/internal/logx"
	"agents-team-relay/internal/realtime"
	"agents-team-relay/internal/storage"
)

// TeamConfigMutation 表示同账号设备提交的一次配置操作。
//
// 参数：Collection 为 agents、rooms 或 settings；Action 为 create、update 或 delete；ID 为实体编号。
// 返回值：由 MutateTeamConfig 在账号事务内应用，BaseRevision 为客户端看到的聊天版本。
// 注意事项：Config 只接受非敏感白名单字段，不能写入聊天、设备身份或本机凭据。
type TeamConfigMutation struct {
	Collection   string
	Action       string
	ID           string
	BaseRevision int64
	Config       json.RawMessage
}

// MutateTeamConfig 原子修改账号共享 Agent、群或执行偏好，并保留同时产生的聊天数据。
//
// 参数：ctx 控制取消；device 是已认证设备；input 描述实体、操作、版本及配置补丁。
// 返回值：完整新快照；过期版本返回 409 和当前快照，非法配置返回 400。
// 注意事项：所有设备权限相同，但只有主电脑执行任务；事务内复核会话，不能跨账号写入。
func (s *Service) MutateTeamConfig(ctx context.Context, device storage.Device, input TeamConfigMutation) (storage.State, error) {
	patch, err := validateTeamMutation(input)
	if err != nil {
		return storage.State{}, err
	}
	logx.Infof("------------- 修改共享配置 account=" + device.AccountID + " device=" + device.ID + " collection=" + input.Collection + " action=" + input.Action + " id=" + input.ID + " --------------")
	var saved storage.State
	unchanged := false
	err = s.store.WithAccount(ctx, device.AccountID, func(tx storage.Tx) error {
		// ------------ 复核账号会话与版本，禁止在途旧令牌或旧快照覆盖 ---------------
		currentDevice, err := tx.Device(ctx, device.ID)
		if errors.Is(err, storage.ErrNotFound) || err == nil && (device.TokenHash == "" || currentDevice.TokenHash != device.TokenHash) {
			return fail(401, "UNAUTHORIZED", "设备令牌无效")
		}
		if err != nil {
			return err
		}
		current, err := tx.State(ctx)
		if err != nil {
			return err
		}
		document, err := decodeObject(current.Body)
		if err != nil {
			return err
		}
		// 同一次创建使用稳定编号；网络响应丢失后的重试不能产生重复对象。
		if input.Action == "create" {
			items, _ := document[input.Collection].([]any)
			for _, raw := range items {
				item, _ := raw.(map[string]any)
				if stringValue(item["id"]) != input.ID {
					continue
				}
				for key, value := range patch {
					if key == "workspace" && patch["workspaceMode"] == "auto" && item["workspaceMode"] == "auto" {
						continue
					}
					if !reflect.DeepEqual(item[key], value) {
						return fail(409, "CONFIG_EXISTS", "这个配置编号已存在且内容不同，请同步后重试")
					}
				}
				saved, unchanged = current, true
				return nil
			}
		}
		if current.Revision != input.BaseRevision {
			return stateConflict(current)
		}
		if current.Revision == 0 {
			document["agents"], document["rooms"] = []any{}, []any{}
			document["settings"] = map[string]any{"localExecution": true, "defaultProvider": "openai"}
		}
		if err := applyTeamMutation(ctx, tx, document, input, patch); err != nil {
			return err
		}
		document["configRevision"] = configRevision(current.Body) + 1
		body, err := json.Marshal(document)
		if err != nil {
			return err
		}
		clean, err := sanitizeState(body, s.stateLimit)
		if err != nil {
			return err
		}
		saved, err = tx.SaveState(ctx, device.ID, clean)
		return err
	})
	if err != nil {
		logx.Warnf("共享配置修改未完成 account=" + device.AccountID + " collection=" + input.Collection + " action=" + input.Action + " id=" + input.ID)
		return storage.State{}, err
	}
	logx.Infof("共享配置已同步 account=" + device.AccountID + " collection=" + input.Collection + " action=" + input.Action + " revision=" + strconv.FormatInt(saved.Revision, 10))
	if !unchanged {
		s.publish(ctx, realtime.Event{AccountID: device.AccountID, Type: "state.updated", Revision: saved.Revision})
	}
	return saved, nil
}

// validateTeamMutation 限定操作类型及配置字段，不读取账号状态。
//
// 参数：input 为未校验的配置请求。
// 返回值：可应用的字段映射，删除操作返回空映射；非法字段返回业务错误。
// 注意事项：引用存在性、重名和运行状态需在账号锁内另外校验。
func validateTeamMutation(input TeamConfigMutation) (map[string]any, error) {
	if input.BaseRevision < 0 || len(input.Config) > 65536 {
		return nil, fail(400, "INVALID", "配置版本或大小不正确")
	}
	if input.Collection != "agents" && input.Collection != "rooms" && input.Collection != "settings" || input.Action != "create" && input.Action != "update" && input.Action != "delete" {
		return nil, fail(400, "INVALID", "配置操作不正确")
	}
	if input.Collection == "settings" {
		if input.Action != "update" || input.ID != "" {
			return nil, fail(400, "INVALID", "共享设置只允许修改")
		}
	} else if !looseIDPattern.MatchString(input.ID) {
		return nil, fail(400, "INVALID", "配置编号格式不正确")
	}
	if input.Action == "delete" {
		if len(input.Config) != 0 {
			return nil, fail(400, "INVALID", "删除操作不能携带配置字段")
		}
		return nil, nil
	}
	var patch map[string]any
	var err error
	switch input.Collection {
	case "agents":
		patch, err = validateAgentConfig(input.Config)
	case "rooms":
		patch, err = validateRoomConfig(input.Config)
	case "settings":
		patch, err = validateSharedSettings(input.Config)
	}
	if err != nil {
		return nil, err
	}
	if input.Action == "create" && strings.TrimSpace(stringValue(patch["name"])) == "" {
		return nil, fail(400, "INVALID", "创建配置需要名称")
	}
	if input.Action == "create" && input.Collection == "rooms" && patch["agentIds"] == nil {
		return nil, fail(400, "INVALID", "团队至少需要一位成员")
	}
	return patch, nil
}

// validateRoomConfig 校验群名称、成员、回复规则和主电脑工作目录。
//
// 参数：config 为群配置补丁。
// 返回值：格式合法的字段映射；成员不存在由事务内检查。
// 注意事项：不接受消息、执行状态或凭据，路径仅保存，绝不在中转站访问。
func validateRoomConfig(config json.RawMessage) (map[string]any, error) {
	patch, err := decodeObject(config)
	if err != nil {
		return nil, err
	}
	if len(patch) == 0 {
		return nil, fail(400, "INVALID", "缺少团队配置")
	}
	for key, value := range patch {
		if key == "agentIds" {
			members, ok := value.([]any)
			if !ok || len(members) == 0 || len(members) > 200 {
				return nil, fail(400, "INVALID", "团队需要 1 到 200 位成员")
			}
			seen := make(map[string]bool, len(members))
			for _, member := range members {
				id := stringValue(member)
				if !looseIDPattern.MatchString(id) || seen[id] {
					return nil, fail(400, "INVALID", "团队成员编号无效或重复")
				}
				seen[id] = true
			}
			continue
		}
		limit := 200
		switch key {
		case "name", "rule":
		case "workspace":
			limit = 2000
		default:
			return nil, fail(400, "INVALID", "包含不允许修改的团队配置字段")
		}
		text, ok := value.(string)
		if !ok || utf8.RuneCountInString(text) > limit || strings.ContainsRune(text, '\x00') || key == "name" && strings.TrimSpace(text) == "" || key == "rule" && text != "free" && text != "mention" {
			return nil, fail(400, "INVALID", "团队配置字段格式或长度不正确")
		}
	}
	return patch, nil
}

// validateSharedSettings 只接受影响主电脑执行的非敏感账号偏好。
//
// 参数：config 为共享设置补丁。
// 返回值：经校验的 localExecution 或 defaultProvider 字段。
// 注意事项：主题、通知、连接地址和模型密钥都是设备设置，不能从此接口同步。
func validateSharedSettings(config json.RawMessage) (map[string]any, error) {
	patch, err := decodeObject(config)
	if err != nil {
		return nil, err
	}
	if len(patch) == 0 {
		return nil, fail(400, "INVALID", "缺少共享设置")
	}
	for key, value := range patch {
		switch key {
		case "localExecution":
			if _, ok := value.(bool); !ok {
				return nil, fail(400, "INVALID", "本地执行开关必须是布尔值")
			}
		case "defaultProvider":
			provider := stringValue(value)
			if provider != "openai" && provider != "anthropic" && provider != "local" && provider != "custom" {
				return nil, fail(400, "INVALID", "默认模型服务商不正确")
			}
		default:
			return nil, fail(400, "INVALID", "包含不允许修改的共享设置字段")
		}
	}
	return patch, nil
}

// applyTeamMutation 在账号锁内修改单个配置实体并检查关联约束。
//
// 参数：tx 为当前事务；document 为最新快照；input 和 patch 是已校验操作及字段。
// 返回值：无返回内容；实体缺失、重名、数量上限或运行冲突返回业务错误。
// 注意事项：直接修改 document，但事务失败不保存；既有消息和其他顶层字段原样保留。
func applyTeamMutation(ctx context.Context, tx storage.Tx, document map[string]any, input TeamConfigMutation, patch map[string]any) error {
	if input.Collection == "settings" {
		settings, _ := document["settings"].(map[string]any)
		if settings == nil {
			settings = map[string]any{}
		}
		for key, value := range patch {
			settings[key] = value
		}
		document["settings"] = settings
		return nil
	}
	items, _ := document[input.Collection].([]any)
	index := -1
	var target map[string]any
	for i, raw := range items {
		item, ok := raw.(map[string]any)
		if ok && stringValue(item["id"]) == input.ID {
			index, target = i, item
			break
		}
	}
	if input.Action == "create" {
		if index >= 0 {
			return fail(409, "CONFIG_EXISTS", "这个配置编号已存在，请同步后重试")
		}
		if len(items) >= 200 {
			return fail(400, "CONFIG_LIMIT", "Agent 和团队各最多创建 200 个")
		}
		target = map[string]any{"id": input.ID, "messages": []any{}}
		if input.Collection == "rooms" {
			target["rule"], target["workspace"] = "free", ""
		}
	} else if index < 0 {
		if input.Collection == "agents" {
			return fail(404, "AGENT_NOT_FOUND", "聊天记录里没有这个 Agent")
		}
		return fail(404, "ROOM_NOT_FOUND", "聊天记录里没有这个团队")
	}
	if input.Collection == "agents" && patch["name"] != nil {
		name := stringValue(patch["name"])
		if strings.ContainsRune(name, '@') || strings.IndexFunc(name, unicode.IsSpace) >= 0 {
			return fail(400, "INVALID", "Agent 名称不能包含空格或 @")
		}
		for _, raw := range items {
			agent, _ := raw.(map[string]any)
			if stringValue(agent["id"]) != input.ID && strings.EqualFold(stringValue(agent["name"]), name) {
				return fail(409, "CONFIG_EXISTS", "这个 Agent 名称已存在，请换一个名称")
			}
		}
	}
	if members, ok := patch["agentIds"].([]any); ok {
		agents, _ := document["agents"].([]any)
		known := make(map[string]bool, len(agents))
		for _, raw := range agents {
			agent, _ := raw.(map[string]any)
			known[stringValue(agent["id"])] = true
		}
		for _, raw := range members {
			if !known[stringValue(raw)] {
				return fail(400, "INVALID", "团队成员包含不存在的 Agent，请同步后重试")
			}
		}
	}
	if input.Action == "delete" || input.Collection == "rooms" && input.Action == "update" && patch["agentIds"] != nil && !reflect.DeepEqual(target["agentIds"], patch["agentIds"]) {
		if err := requireConfigIdle(ctx, tx, document, input.Collection, input.ID); err != nil {
			return err
		}
	}
	if input.Action == "delete" {
		if input.Collection == "agents" && len(items) <= 1 {
			return fail(400, "LAST_AGENT", "至少需要保留一个 Agent")
		}
		items = append(items[:index], items[index+1:]...)
		document[input.Collection] = items
		if input.Collection == "agents" {
			fallback, _ := items[0].(map[string]any)
			rooms, _ := document["rooms"].([]any)
			for _, raw := range rooms {
				room, ok := raw.(map[string]any)
				if !ok || room == nil {
					continue
				}
				members, _ := room["agentIds"].([]any)
				remaining := make([]any, 0, len(members))
				for _, member := range members {
					if stringValue(member) != input.ID {
						remaining = append(remaining, member)
					}
				}
				if len(remaining) == 0 {
					remaining = []any{fallback["id"]}
				}
				room["agentIds"] = remaining
			}
		}
		return nil
	}
	for key, value := range patch {
		target[key] = value
	}
	if input.Action == "create" {
		document[input.Collection] = append(items, target)
	}
	return nil
}

// requireConfigIdle 防止删除或移除成员导致在途任务无法保存回复。
//
// 参数：tx 为账号事务；document 为当前快照；collection 和 id 标识受影响实体。
// 返回值：仍有排队或执行中的关联任务时返回 409 CONFIG_IN_USE。
// 注意事项：群内后续 @ 可选择初始 responders 以外的成员，因此删除成员须检查整个群。
func requireConfigIdle(ctx context.Context, tx storage.Tx, document map[string]any, collection, id string) error {
	affectedRooms := map[string]bool{}
	if collection == "rooms" {
		affectedRooms[id] = true
	} else {
		rooms, _ := document["rooms"].([]any)
		for _, raw := range rooms {
			room, _ := raw.(map[string]any)
			members, _ := room["agentIds"].([]any)
			for _, member := range members {
				if stringValue(member) == id {
					affectedRooms[stringValue(room["id"])] = true
				}
			}
		}
	}
	// 主电脑本地发起的任务不经过派发表，仍须保护它正在使用的会话。
	execution, _ := document["execution"].(map[string]any)
	running, _ := execution["running"].(map[string]any)
	key := stringValue(running["key"])
	if affectedRooms[strings.TrimPrefix(key, "room:")] && strings.HasPrefix(key, "room:") || collection == "agents" && (key == "agent:"+id || stringValue(running["agentId"]) == id) {
		return fail(409, "CONFIG_IN_USE", "主电脑正在使用这个会话，请停止或等待完成后再修改")
	}
	if collection == "agents" {
		active, _ := running["agentIds"].([]any)
		for _, agent := range active {
			if stringValue(agent) == id {
				return fail(409, "CONFIG_IN_USE", "主电脑正在使用这个 Agent，请停止或等待完成后再删除")
			}
		}
	}
	roomIDs := make([]string, 0, len(affectedRooms))
	for roomID := range affectedRooms {
		roomIDs = append(roomIDs, roomID)
	}
	agentID := ""
	if collection == "agents" {
		agentID = id
	}
	busy, err := tx.ConfigInUse(ctx, agentID, roomIDs)
	if err != nil {
		return err
	}
	if busy {
		return fail(409, "CONFIG_IN_USE", "相关会话还有任务，请等待完成后再删除或调整成员")
	}
	return nil
}

// sharedConfigMatches 防止整份聊天快照绕过共享配置接口覆盖账号配置。
//
// 参数：current 为服务器快照；incoming 为主电脑准备保存的快照。
// 返回值：实体集合和已存在的共享字段一致时返回 true。
// 注意事项：缺省旧字段可由主电脑补全；auto 工作区实际路径可派生回填，显式项目路径必须保持一致。
func sharedConfigMatches(current, incoming []byte) bool {
	before, err := decodeObject(current)
	if err != nil {
		return false
	}
	after, err := decodeObject(incoming)
	if err != nil {
		return false
	}
	fields := map[string][]string{
		"agents": {"name", "initial", "label", "role", "persona", "provider", "model", "backend", "harness", "harnessModel", "workspaceMode", "workspace", "endpoint", "temperature"},
		"rooms":  {"name", "agentIds", "rule", "workspace"},
	}
	for collection, keys := range fields {
		previous, _ := before[collection].([]any)
		next, _ := after[collection].([]any)
		if len(previous) != len(next) {
			return false
		}
		byID := make(map[string]map[string]any, len(next))
		for _, raw := range next {
			item, ok := raw.(map[string]any)
			id := stringValue(item["id"])
			if !ok || id == "" || byID[id] != nil {
				return false
			}
			byID[id] = item
		}
		for _, raw := range previous {
			item, _ := raw.(map[string]any)
			candidate := byID[stringValue(item["id"])]
			if candidate == nil {
				return false
			}
			for _, key := range keys {
				value, exists := item[key]
				if !exists {
					continue
				}
				if collection == "agents" && key == "workspace" && item["workspaceMode"] == "auto" && candidate["workspaceMode"] == "auto" {
					path, ok := candidate[key].(string)
					if !ok || utf8.RuneCountInString(path) > 2000 || strings.ContainsRune(path, '\x00') {
						return false
					}
					continue
				}
				if !reflect.DeepEqual(value, candidate[key]) {
					return false
				}
			}
		}
	}
	previousSettings, _ := before["settings"].(map[string]any)
	nextSettings, _ := after["settings"].(map[string]any)
	for _, key := range []string{"localExecution", "defaultProvider"} {
		if value, exists := previousSettings[key]; exists && !reflect.DeepEqual(value, nextSettings[key]) {
			return false
		}
	}
	return true
}
