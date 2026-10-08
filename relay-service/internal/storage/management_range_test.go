package storage

import (
	"context"
	"testing"
	"time"
)

// TestEmptyOverviewTrend 验证序列跨越闰日且所有维度补零。参数：t为测试句柄；返回值：无；注意事项：每一天的数据独立，索引和序列引用同一天。
func TestEmptyOverviewTrend(t *testing.T) {
	start := time.Date(2024, 2, 28, 0, 0, 0, 0, time.UTC)
	end := start.AddDate(0, 0, 2)
	trend, byDate, err := emptyOverviewTrend(start, end)
	if err != nil || len(trend) != 3 || len(byDate) != 3 {
		t.Fatal("补零序列长度错误", err)
	}
	for index, date := range []string{"2024-02-28", "2024-02-29", "2024-03-01"} {
		if trend[index]["date"] != date {
			t.Fatal("日序列缺失或乱序", trend)
		}
		for _, key := range []string{"accountsCreated", "devicesCreated", "total", "completed", "failed", "pending", "running"} {
			if trend[index][key] != int64(0) {
				t.Fatal("空日期未补零", date, key)
			}
		}
	}
	byDate["2024-02-29"]["total"] = int64(2)
	if trend[1]["total"] != int64(2) || trend[0]["total"] != int64(0) || trend[2]["total"] != int64(0) {
		t.Fatal("日序列数据相互覆盖")
	}
}

// TestOverviewRejectsUnboundedStorageRanges 验证存储层也阻止无界区间。参数：t为测试句柄；返回值：无；注意事项：使用空数据库句柄证明错误范围在执行SQL之前被拒绝。
func TestOverviewRejectsUnboundedStorageRanges(t *testing.T) {
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, end := range []time.Time{start.AddDate(0, 0, -1), start.AddDate(0, 0, 366), start.Add(time.Hour)} {
		if _, err := (&MySQL{}).ManagementOverview(context.Background(), "", start, end); err == nil {
			t.Fatal("存储层接受无效日期范围", end)
		}
	}
	trend, _, err := emptyOverviewTrend(start, start.AddDate(0, 0, 365))
	if err != nil || len(trend) != MaxOverviewDays {
		t.Fatal("合法366天区间被拒绝", err)
	}
}
