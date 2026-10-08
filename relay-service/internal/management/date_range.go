package management

import (
	"fmt"
	"net/url"
	"time"

	"agents-team-relay/internal/storage"
)

// overviewDateRange 校验总览趋势日期。参数：query 为查询条件，now 为服务器当前时间；返回值：UTC首尾日期或可公开错误；注意事项：首尾均包含，默认最近30天，禁止未来日期和超过366天的区间。
func overviewDateRange(query url.Values, now time.Time) (time.Time, time.Time, error) {
	today := now.UTC().Truncate(24 * time.Hour)
	starts, ends := query["startDate"], query["endDate"]
	if len(starts) == 0 && len(ends) == 0 {
		return today.AddDate(0, 0, -29), today, nil
	}
	if len(starts) != 1 || len(ends) != 1 {
		return time.Time{}, time.Time{}, fmt.Errorf("开始和结束日期必须同时提供，且不能重复")
	}
	start, startErr := time.Parse("2006-01-02", starts[0])
	end, endErr := time.Parse("2006-01-02", ends[0])
	if startErr != nil || endErr != nil || start.Year() < 1000 || end.Year() < 1000 || start.Format("2006-01-02") != starts[0] || end.Format("2006-01-02") != ends[0] {
		return time.Time{}, time.Time{}, fmt.Errorf("请使用有效的 YYYY-MM-DD 日期")
	}
	if start.After(end) {
		return time.Time{}, time.Time{}, fmt.Errorf("开始日期不能晚于结束日期")
	}
	if end.After(today) {
		return time.Time{}, time.Time{}, fmt.Errorf("不能查询未来的 UTC 日期")
	}
	if end.Sub(start)/(24*time.Hour) >= storage.MaxOverviewDays {
		return time.Time{}, time.Time{}, fmt.Errorf("日期范围最多包含 %d 天", storage.MaxOverviewDays)
	}
	return start, end, nil
}
