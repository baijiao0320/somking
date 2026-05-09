/**
 * 控烟监测数据平台 - 前端逻辑
 *
 * 架构：OBS 静态托管前端 + 函数工作流后端预计算 JSON
 * ============================================================
 * 后端需在 OBS 中提供以下 JSON 文件（/data/ 目录下）：
 * ============================================================
 *
 * 1. /data/locations.json
 *    [
 *      {"id": "s300", "name": "一楼大厅"},
 *      {"id": "s301", "name": "二楼走廊"},
 *      ...
 *    ]
 *
 * 2. /data/{id}.json  （每个地点一个文件，文件名 = id）
 *    {
 *      "today": {
 *        "event_time_confirmed": ["00:00","00:15", ...],
 *        "pm1_0": [35.2, 36.1, ...],
 *        "pm2_5": [42.1, 43.0, ...]
 *      },
 *      "today_stats": {
 *        "algo_a_event_total_confirmed":    123,
 *        "daily_total_confirmed":           4567,
 *        "algo_a_event_per_100_confirmed":  2.69
 *      },
 *      "week_daily_avg": {
 *        "dates":      ["05/01","05/02", ..., "05/07"],
 *        "pm1_0_avg":  [30.1, 31.2, ...],
 *        "pm2_5_avg":  [38.5, 39.1, ...]
 *      },
 *      "week_trigger_per_100": {
 *        "dates":                ["05/01","05/02", ..., "05/07"],
 *        "algo_a_event_per_100": [2.5, 2.7, ...]
 *      }
 *    }
 *
 * 约束：
 * - today 下三个数组等长；week_daily_avg 下三个数组等长；
 *   week_trigger_per_100 下两个数组等长
 * - 相邻 event_time_confirmed 间隔超过 30 秒时前端自动断线（connectNulls: false）
 * - 后端建议按 10 秒聚合 PM 数据；前端 dataZoom 支持缩放查看细节
 * - 函数工作流定时计算并覆写 OBS 上的 JSON 即可
 */

(function () {
    'use strict';

    /* ===================== 配置 ===================== */
    var API_BASE = './data/';
    var DEFAULT_LOCATION_INDEX = 0;
    var REFRESH_INTERVAL = 30000; // 自动刷新间隔（毫秒）

    /* ===================== 状态 ===================== */
    var locations = [];
    var currentId = null;
    var refreshTimer = null;

    /* ===================== ECharts 实例 ===================== */
    var chartTodayPM = null;
    var chartWeekPM = null;
    var chartWeekTrigger = null;

    /* ===================== DOM 引用 ===================== */
    var $locationTabs = document.getElementById('locationTabs');
    var $chartTodayPM = document.getElementById('chartTodayPM');
    var $chartWeekPM = document.getElementById('chartWeekPM');
    var $chartWeekTrigger = document.getElementById('chartWeekTrigger');
    var $valTrigger = document.getElementById('valTrigger');
    var $valPerson = document.getElementById('valPerson');
    var $valPer100 = document.getElementById('valPer100');

    /* ===================== 工具函数 ===================== */

    function fetchJSON(url) {
        // 加时间戳参数破除浏览器/中间代理缓存
        var sep = url.indexOf('?') === -1 ? '?' : '&';
        var cacheBustUrl = url + sep + '_t=' + Date.now();
        return fetch(cacheBustUrl, { cache: 'no-store' }).then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + url);
            return res.json();
        });
    }

    /* ===================== 数据预处理：断点检测 ===================== */

    function toSeconds(t) {
        var parts = t.split(':');
        return (+parts[0]) * 3600 + (+parts[1]) * 60 + (+(parts[2] || 0));
    }

    function toTimestamp(t) {
        var parts = t.split(':');
        var h = +parts[0];
        var m = +parts[1];
        var s = +(parts[2] || 0);
        var now = new Date();
        return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, s).getTime();
    }

    function insertNullForGaps(today) {
        var times = today.event_time_confirmed;
        var pm1 = today.pm1_0;
        var pm2 = today.pm2_5;
        var gapThreshold = 30;

        var newTimes = [];
        var newPm1 = [];
        var newPm2 = [];

        for (var i = 0; i < times.length; i++) {
            newTimes.push(times[i]);
            newPm1.push(pm1[i]);
            newPm2.push(pm2[i]);

            if (i < times.length - 1) {
                var gap = toSeconds(times[i + 1]) - toSeconds(times[i]);
                if (gap > gapThreshold) {
                    var midSec = Math.floor((toSeconds(times[i]) + toSeconds(times[i + 1])) / 2);
                    var h = Math.floor(midSec / 3600);
                    var m = Math.floor((midSec % 3600) / 60);
                    var s = midSec % 60;
                    var midTime = (h < 10 ? '0' + h : h) + ':'
                        + (m < 10 ? '0' + m : m) + ':'
                        + (s < 10 ? '0' + s : s);
                    newTimes.push(midTime);
                    newPm1.push(null);
                    newPm2.push(null);
                }
            }
        }

        return {
            event_time_confirmed: newTimes,
            pm1_0: newPm1,
            pm2_5: newPm2
        };
    }

    /* ===================== 渲染：地点选择 ===================== */

    function renderLocationTabs(activeId) {
        var html = '';
        locations.forEach(function (loc) {
            var cls = loc.id === activeId ? ' location-tab active' : 'location-tab';
            html += '<span class="' + cls + '" data-id="' + loc.id + '">' + loc.name + '</span>';
        });
        $locationTabs.innerHTML = html;

        $locationTabs.querySelectorAll('.location-tab').forEach(function (el) {
            el.addEventListener('click', function () {
                var id = el.getAttribute('data-id');
                if (id !== currentId) switchLocation(id);
            });
        });
    }

    /* ===================== 渲染：当日 PM 曲线 ===================== */

    function renderTodayPMChart(today) {
        var pm1Data = today.event_time_confirmed.map(function (t, i) {
            return [toTimestamp(t), today.pm1_0[i]];
        });
        var pm2Data = today.event_time_confirmed.map(function (t, i) {
            return [toTimestamp(t), today.pm2_5[i]];
        });

        function formatTime(v) {
            var d = new Date(v);
            return ('0' + d.getHours()).slice(-2) + ':'
                + ('0' + d.getMinutes()).slice(-2) + ':'
                + ('0' + d.getSeconds()).slice(-2);
        }

        // 根据数据跨度计算初始可视范围，同时约束横轴到数据范围
        var tenSec = 10000;
        var midnight = toTimestamp('00:00:00');

        var firstTs = toTimestamp(today.event_time_confirmed[0]);
        var lastTs = toTimestamp(today.event_time_confirmed[today.event_time_confirmed.length - 1]);

        // 起：第一个数据前的整十秒；止：最后数据后的整十秒
        var viewMin = midnight + Math.floor((firstTs - midnight) / tenSec) * tenSec;
        var viewMax = midnight + Math.ceil((lastTs - midnight) / tenSec) * tenSec;

        var dataSpan = viewMax - viewMin;
        var twoHours = 7200000;

        // 初始显示：跨度 > 2h 只显示 2h，否则显示全部
        var zoomEndPct;
        if (dataSpan > twoHours) {
            zoomEndPct = twoHours / dataSpan * 100;
        } else {
            zoomEndPct = 100;
        }

        if (!chartTodayPM) {
            chartTodayPM = echarts.init($chartTodayPM);

            chartTodayPM.setOption({
                color: ['#d4a373', '#7b9cb5'],
                tooltip: {
                    trigger: 'axis',
                    backgroundColor: '#fff',
                    borderColor: '#e8e4db',
                    textStyle: { color: '#4a4947', fontSize: 13 },
                    formatter: function (params) {
                        var time = formatTime(params[0].axisValue);
                        var s = '<b>' + time + '</b><br/>';
                        params.forEach(function (p) {
                            if (p.value == null) return;
                            s += '<span style="display:inline-block;width:10px;height:10px;'
                                + 'border-radius:50%;background:' + p.color
                                + ';margin-right:6px;"></span>'
                                + p.seriesName + '：' + p.value + ' μg/m³<br/>';
                        });
                        return s;
                    }
                },
                legend: {
                    data: ['PM1.0', 'PM2.5'],
                    top: 0, left: 'center',
                    textStyle: { color: '#8a8985' },
                    itemWidth: 22,
                    itemHeight: 3
                },
                grid: { left: 68, right: 50, top: 36, bottom: 60 },
                xAxis: {
                    type: 'time',
                    min: viewMin,
                    max: viewMax,
                    minInterval: 10000,
                    axisLine: { lineStyle: { color: '#e8e4db' } },
                    axisTick: { show: false },
                    splitLine: { show: false },
                    axisLabel: {
                        color: '#8a8985',
                        fontSize: 11,
                        formatter: function (v) {
                            var d = new Date(v);
                            if (d.getSeconds() % 10 !== 0) return '';
                            return ('0' + d.getHours()).slice(-2) + ':'
                                + ('0' + d.getMinutes()).slice(-2) + ':'
                                + ('0' + d.getSeconds()).slice(-2);
                        }
                    }
                },
                yAxis: {
                    type: 'value',
                    name: 'μg/m³',
                    nameGap: 12,
                    nameTextStyle: { color: '#8a8985', fontSize: 12 },
                    axisLine: { show: false },
                    axisTick: { show: false },
                    splitLine: { lineStyle: { color: '#f0ede5', type: 'dashed' } },
                    axisLabel: { color: '#8a8985', fontSize: 11 }
                },
                dataZoom: [
                    { type: 'inside', start: 0, end: zoomEndPct, minSpan: 1, filterMode: 'none' },
                    {
                        type: 'slider', start: 0, end: zoomEndPct, height: 22, bottom: 0, filterMode: 'none',
                        borderColor: '#e8e4db', backgroundColor: '#fafaf7',
                        fillerColor: 'rgba(139,157,131,0.18)',
                        handleStyle: { color: '#8b9d83' },
                        textStyle: { color: '#8a8985', fontSize: 10 }
                    }
                ],
                series: [
                    {
                        name: 'PM1.0', type: 'line', data: pm1Data,
                        connectNulls: false,
                        smooth: true, symbol: 'none', lineStyle: { width: 2 },
                        areaStyle: { color: 'rgba(212,163,115,0.1)' }
                    },
                    {
                        name: 'PM2.5', type: 'line', data: pm2Data,
                        connectNulls: false,
                        smooth: true, symbol: 'none', lineStyle: { width: 2 },
                        areaStyle: { color: 'rgba(123,156,181,0.1)' }
                    }
                ]
            });
        } else {
            chartTodayPM.setOption({
                series: [
                    { data: pm1Data },
                    { data: pm2Data }
                ]
            });
        }
    }

    /* ===================== 渲染：信息卡 ===================== */

    function renderInfoCards(stats) {
        $valTrigger.textContent = stats.algo_a_event_total_confirmed;
        $valPerson.textContent = stats.daily_total_confirmed;
        $valPer100.textContent = stats.algo_a_event_per_100_confirmed;
    }

    /* ===================== 渲染：七日图表 ===================== */

    function renderWeekCharts(data) {
        // --- 七日日均 PM 波动 ---
        var weekAvg = data.week_daily_avg;

        if (!chartWeekPM) {
            chartWeekPM = echarts.init($chartWeekPM);

            chartWeekPM.setOption({
                color: ['#d4a373', '#7b9cb5'],
                tooltip: {
                    trigger: 'axis',
                    backgroundColor: '#fff',
                    borderColor: '#e8e4db',
                    textStyle: { color: '#4a4947', fontSize: 13 },
                    formatter: function (params) {
                        var s = '<b>' + params[0].axisValue + '</b><br/>';
                        params.forEach(function (p) {
                            s += '<span style="display:inline-block;width:10px;height:10px;'
                                + 'border-radius:50%;background:' + p.color
                                + ';margin-right:6px;"></span>'
                                + p.seriesName + '：' + p.value + ' μg/m³<br/>';
                        });
                        return s;
                    }
                },
                legend: {
                    data: ['PM1.0日均', 'PM2.5日均'],
                    top: 0, left: 'center',
                    textStyle: { color: '#8a8985' },
                    itemWidth: 22, itemHeight: 3
                },
                grid: { left: 68, right: 50, top: 36, bottom: 60 },
                xAxis: {
                    type: 'category', data: weekAvg.dates, boundaryGap: false,
                    axisLine: { lineStyle: { color: '#e8e4db' } },
                    axisTick: { show: false },
                    axisLabel: { color: '#8a8985', fontSize: 11 }
                },
                yAxis: {
                    type: 'value', name: 'μg/m³', nameGap: 12,
                    nameTextStyle: { color: '#8a8985', fontSize: 12 },
                    axisLine: { show: false }, axisTick: { show: false },
                    splitLine: { lineStyle: { color: '#f0ede5', type: 'dashed' } },
                    axisLabel: { color: '#8a8985', fontSize: 11 }
                },
                dataZoom: [
                    { type: 'inside', start: 0, end: 100, filterMode: 'none' },
                    {
                        type: 'slider', start: 0, end: 100, height: 22, bottom: 0, filterMode: 'none',
                        borderColor: '#e8e4db', backgroundColor: '#fafaf7',
                        fillerColor: 'rgba(139,157,131,0.18)',
                        handleStyle: { color: '#8b9d83' },
                        textStyle: { color: '#8a8985', fontSize: 10 }
                    }
                ],
                series: [
                    {
                        name: 'PM1.0日均', type: 'line', data: weekAvg.pm1_0_avg,
                        smooth: true, symbol: 'circle', symbolSize: 5,
                        lineStyle: { width: 2 },
                        areaStyle: { color: 'rgba(212,163,115,0.1)' }
                    },
                    {
                        name: 'PM2.5日均', type: 'line', data: weekAvg.pm2_5_avg,
                        smooth: true, symbol: 'circle', symbolSize: 5,
                        lineStyle: { width: 2 },
                        areaStyle: { color: 'rgba(123,156,181,0.1)' }
                    }
                ]
            });
        } else {
            chartWeekPM.setOption({
                xAxis: { data: weekAvg.dates },
                series: [
                    { data: weekAvg.pm1_0_avg },
                    { data: weekAvg.pm2_5_avg }
                ]
            });
        }

        // --- 七日每百人触发次数波动 ---
        var trig = data.week_trigger_per_100;

        if (!chartWeekTrigger) {
            chartWeekTrigger = echarts.init($chartWeekTrigger);

            chartWeekTrigger.setOption({
                color: ['#c4876e'],
                tooltip: {
                    trigger: 'axis',
                    backgroundColor: '#fff',
                    borderColor: '#e8e4db',
                    textStyle: { color: '#4a4947', fontSize: 13 },
                    formatter: function (params) {
                        return '<b>' + params[0].axisValue + '</b><br/>'
                            + '<span style="display:inline-block;width:10px;height:10px;'
                            + 'border-radius:50%;background:' + params[0].color
                            + ';margin-right:6px;"></span>'
                            + '每百人触发：' + params[0].value + ' 次';
                    }
                },
                legend: {
                    data: ['每百人触发次数'],
                    top: 0, left: 'center',
                    textStyle: { color: '#8a8985' },
                    itemWidth: 22, itemHeight: 3
                },
                grid: { left: 68, right: 50, top: 36, bottom: 60 },
                xAxis: {
                    type: 'category', data: trig.dates, boundaryGap: false,
                    axisLine: { lineStyle: { color: '#e8e4db' } },
                    axisTick: { show: false },
                    axisLabel: { color: '#8a8985', fontSize: 11 }
                },
                yAxis: {
                    type: 'value', name: '次/百人', nameGap: 12,
                    nameTextStyle: { color: '#8a8985', fontSize: 12 },
                    axisLine: { show: false }, axisTick: { show: false },
                    splitLine: { lineStyle: { color: '#f0ede5', type: 'dashed' } },
                    axisLabel: { color: '#8a8985', fontSize: 11 }
                },
                dataZoom: [
                    { type: 'inside', start: 0, end: 100, filterMode: 'none' },
                    {
                        type: 'slider', start: 0, end: 100, height: 22, bottom: 0, filterMode: 'none',
                        borderColor: '#e8e4db', backgroundColor: '#fafaf7',
                        fillerColor: 'rgba(139,157,131,0.18)',
                        handleStyle: { color: '#8b9d83' },
                        textStyle: { color: '#8a8985', fontSize: 10 }
                    }
                ],
                series: [{
                    name: '每百人触发次数', type: 'line', data: trig.algo_a_event_per_100,
                    smooth: true, symbol: 'circle', symbolSize: 5,
                    lineStyle: { width: 2.5 },
                    areaStyle: { color: 'rgba(196,135,110,0.12)' }
                }]
            });
        } else {
            chartWeekTrigger.setOption({
                xAxis: { data: trig.dates },
                series: [
                    { data: trig.algo_a_event_per_100 }
                ]
            });
        }
    }

    /* ===================== 清空图表 ===================== */

    function clearAllCharts() {
        if (chartTodayPM) { chartTodayPM.dispose(); chartTodayPM = null; }
        if (chartWeekPM) { chartWeekPM.dispose(); chartWeekPM = null; }
        if (chartWeekTrigger) { chartWeekTrigger.dispose(); chartWeekTrigger = null; }
    }

    /* ===================== 数据加载 ===================== */

    function loadLocationData(locId) {
        [$valTrigger, $valPerson, $valPer100].forEach(function (el) {
            el.textContent = '...';
        });

        fetchJSON(API_BASE + locId + '.json').then(function (data) {
            data.today = insertNullForGaps(data.today);
            renderTodayPMChart(data.today);
            renderInfoCards(data.today_stats);
            renderWeekCharts(data);
        }).catch(function (err) {
            console.error('数据加载失败：' + err.message);
            [$valTrigger, $valPerson, $valPer100].forEach(function (el) {
                el.textContent = '--';
            });
            clearAllCharts();
        });
    }

    function switchLocation(locId) {
        currentId = locId;
        renderLocationTabs(locId);
        clearAllCharts();
        loadLocationData(locId);
        startAutoRefresh();
    }

    /* ===================== resize ===================== */

    function onResize() {
        if (chartTodayPM) chartTodayPM.resize();
        if (chartWeekPM) chartWeekPM.resize();
        if (chartWeekTrigger) chartWeekTrigger.resize();
    }

    window.addEventListener('resize', onResize);

    /* ===================== 自动刷新 ===================== */

    function startAutoRefresh() {
        stopAutoRefresh();
        refreshTimer = setInterval(function () {
            if (currentId) loadLocationData(currentId);
        }, REFRESH_INTERVAL);
    }

    function stopAutoRefresh() {
        if (refreshTimer) {
            clearInterval(refreshTimer);
            refreshTimer = null;
        }
    }

    /* ===================== 初始化 ===================== */

    function init() {
        fetchJSON(API_BASE + 'locations.json').then(function (locList) {
            locations = locList;
            if (!locations.length) {
                console.error('地点列表为空');
                return;
            }
            currentId = locations[DEFAULT_LOCATION_INDEX].id;
            renderLocationTabs(currentId);
            loadLocationData(currentId);
            startAutoRefresh();
        }).catch(function (err) {
            console.error('locations.json 加载失败：' + err.message);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
