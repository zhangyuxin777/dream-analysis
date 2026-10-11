# -*- coding: utf-8 -*-
"""
dream-analysis 事件分片 -> 看板聚合数据 summary.json
口径遵循 ops.md：
- roundId 会重号：轮号 = roundId 第一段（如 R059），按 (symbol, 轮号) 聚合、按时间排序、遇 completed 切段
- -RCV 接管链并入同轮号
时区：ts 为 UTC，展示一律转北京时间（UTC+8）
"""
import gzip, json, glob, os
from datetime import datetime, timedelta, timezone

BEIJING = timezone(timedelta(hours=8))
RAW = os.environ.get("DREAM_RAW", os.path.join(os.path.dirname(__file__), "raw"))
OUT = os.environ.get("SUMMARY_OUT", os.path.join(os.path.dirname(__file__), "summary.json"))

def bj(ts_str):
    return datetime.fromisoformat(ts_str.replace("Z", "+00:00")).astimezone(BEIJING)

def load_events(instance):
    events = []
    for path in sorted(glob.glob(os.path.join(RAW, instance, "*.jsonl.gz"))):
        with gzip.open(path, "rt", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    e = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if e.get("type") == "meta":
                    continue
                events.append(e)
    events.sort(key=lambda e: (e.get("ts", ""), e.get("seq", 0)))
    return events

def round_no(rid):
    return rid.split("-")[0] if rid else "?"

def summarize(instance, events):
    dataset_end = bj(events[-1]["ts"]) if events else datetime.now(BEIJING)
    # 资金曲线
    equity = []
    for e in events:
        if e.get("event") != "ACCOUNT_OBSERVED":
            continue
        d = e["data"]
        free = locked = 0.0
        for b in d.get("balances", []):
            if b["asset"] == "FDUSD":
                free += b.get("qtyFree", 0)
                locked += b.get("qtyLocked", 0)
        total = d.get("totalValue", 0)
        equity.append({
            "t": bj(e["ts"]).isoformat(),
            "total": round(total, 2),
            "free": round(free, 2),
            "locked": round(locked, 2),
            "idlePct": round(free / total * 100, 1) if total else 0,
        })

    # 每个币种最新市价：优先从 ACCOUNT_OBSERVED 的持仓估值反推（value / 数量），
    # 事件流里的 bidPrice 在深跌防守期间会停更，不可靠
    last_price = {}
    for e in events:
        if e.get("event") != "ACCOUNT_OBSERVED":
            continue
        for b in e["data"].get("balances", []):
            qty = b.get("qtyFree", 0) + b.get("qtyLocked", 0)
            if b["asset"] != "FDUSD" and qty > 0 and b.get("value", 0) > 0:
                last_price[b["asset"]] = round(b["value"] / qty, 2)

    def coin(sym):
        return sym.replace("FDUSD", "")

    # 入金检测：相邻快照总权益跳升 > 3% 记为一次注资
    deposits = []
    for a, b in zip(equity, equity[1:]):
        if a["total"] > 0 and b["total"] - a["total"] > a["total"] * 0.03:
            deposits.append({"t": b["t"], "amount": round(b["total"] - a["total"], 2)})
    deposit_by_t = {d["t"]: d["amount"] for d in deposits}

    # 每日净盈亏（权益口径，含浮盈浮亏）：相邻快照的权益差，按后一个快照的北京时间日期归属，剔除入金
    day_net = {}
    for a, b in zip(equity, equity[1:]):
        day = b["t"][:10]
        net = b["total"] - a["total"] - deposit_by_t.get(b["t"], 0.0)
        day_net[day] = round(day_net.get(day, 0.0) + net, 2)

    # 轮次分段：按 (symbol, 轮号) 切段，遇 completed 开始新段
    segments = {}  # (symbol, roundno) -> list of segments; segment = {"events":[...], "completed":bool}
    seg_list = []
    for e in events:
        rid = e.get("roundId")
        if not rid:
            continue
        key = (e.get("symbol", "?"), round_no(rid))
        if key not in segments or segments[key]["completed"]:
            segments[key] = {"events": [], "completed": False, "symbol": key[0], "roundNo": key[1]}
            seg_list.append(segments[key])
        segments[key]["events"].append(e)
        if e.get("event") == "ROUND_COMPLETED":
            segments[key]["completed"] = True

    completed_rounds = []
    stuck = []
    reset_killed = 0
    for seg in seg_list:
        evs = seg["events"]
        comp = next((e for e in evs if e["event"] == "ROUND_COMPLETED"), None)
        if comp:
            d = comp["data"]
            completed_rounds.append({
                "symbol": seg["symbol"], "roundNo": seg["roundNo"],
                "t": bj(comp["ts"]).isoformat(),
                "profit": d.get("profit", 0),
                "hours": round(d.get("durationHours", 0), 2),
                "accCost": d.get("accCost", 0),
                "isCrash": d.get("isCrashMode", False),
                "avgBuy": d.get("avgBuyPrice", 0),
                "sell": d.get("sellPrice", 0),
                "resets": sum(1 for e in evs if e["event"] == "WORKER_DEVIATION_RESET"),
            })
            continue
        # 未完成段：有被向上复位掐掉的可能
        resets = [e for e in evs if e["event"] == "WORKER_DEVIATION_RESET"]
        buys = [e for e in evs if e["event"] == "BUY_FILLED"]
        if resets and not buys:
            reset_killed += 1
        if buys:
            last_buy = buys[-1]
            # accCost 是链上累计花费：用差值算每格数量，得出真实加权均价
            total_cost, total_qty = 0.0, 0.0
            prev = 0.0
            for b in buys:
                c = b["data"].get("accCost", 0)
                seg_cost = max(c - prev, 0.0)
                prev = c
                p = b["data"].get("buyPrice", 0)
                if p > 0:
                    total_cost += seg_cost
                    total_qty += seg_cost / p
            avg_buy = round(total_cost / total_qty, 2) if total_qty else last_buy["data"].get("buyPrice", 0)
            lp = last_price.get(coin(seg["symbol"]))
            stuck.append({
                "symbol": seg["symbol"], "roundNo": seg["roundNo"],
                "since": bj(last_buy["ts"]).isoformat(),
                "hours": round((dataset_end - bj(last_buy["ts"])).total_seconds() / 3600, 1),
                "avgBuy": avg_buy,
                "qty": round(total_qty, 6),
                "accCost": round(prev, 2),
                "lastPrice": lp,
                "floating": round(total_qty * (lp - avg_buy), 2) if lp and total_qty else None,
                "floatingPct": round((lp - avg_buy) / avg_buy * 100, 2) if lp and avg_buy else None,
                "resets": len(resets),
                "reductions": sum(1 for e in evs if e["event"] == "DYNAMIC_PROFIT_REDUCED"),
                "crash": any(e["event"] == "CRASH_ENTERED" for e in evs),
                "lastEvent": evs[-1]["event"],
            })

    # 日维度（北京时间）
    daily = {}
    for e in events:
        day = bj(e["ts"]).strftime("%Y-%m-%d")
        d = daily.setdefault(day, {"date": day, "profit": 0.0, "rounds": 0, "new": 0, "resets": 0,
                                   "crashIn": 0, "crashOut": 0, "sells": 0})
        ev = e.get("event")
        if ev == "ROUND_COMPLETED":
            d["profit"] = round(d["profit"] + e["data"].get("profit", 0), 2)
            d["rounds"] += 1
        elif ev == "NEW_ROUND":
            d["new"] += 1
        elif ev == "WORKER_DEVIATION_RESET":
            d["resets"] += 1
        elif ev == "CRASH_ENTERED":
            d["crashIn"] += 1
        elif ev == "CRASH_EXITED":
            d["crashOut"] += 1
        elif ev == "SELL_FILLED":
            d["sells"] += 1
    # 合并每日净盈亏（权益口径）；无快照的日期保持 None
    for day, net in day_net.items():
        if day in daily:
            daily[day]["net"] = net
        else:
            daily[day] = {"date": day, "profit": 0.0, "rounds": 0, "new": 0, "resets": 0,
                          "crashIn": 0, "crashOut": 0, "sells": 0, "net": net}

    # 深跌事件
    crashes = []
    open_crash = {}
    for e in events:
        ev, d = e.get("event"), e.get("data", {})
        if ev == "CRASH_ENTERED":
            open_crash[e.get("symbol")] = {"symbol": e["symbol"], "start": bj(e["ts"]).isoformat(),
                                           "dropPct": round(d.get("dropPercent", 0) * 100, 2), "end": None}
        elif ev == "CRASH_EXITED" and e["symbol"] in open_crash:
            open_crash[e["symbol"]]["end"] = bj(e["ts"]).isoformat()
            crashes.append(open_crash.pop(e["symbol"]))
    crashes.extend(open_crash.values())

    total_profit = round(sum(r["profit"] for r in completed_rounds), 2)
    new_rounds = sum(d["new"] for d in daily.values())
    resets_n = sum(d["resets"] for d in daily.values())
    total_resets_in_rounds = sum(r["resets"] for r in completed_rounds) + sum(s["resets"] for s in stuck)
    durations = sorted(r["hours"] for r in completed_rounds)

    first_eq = equity[0]["total"] if equity else None
    last_eq = equity[-1]["total"] if equity else None

    return {
        "instance": instance,
        "datasetEnd": dataset_end.isoformat(),
        "range": {"from": equity[0]["t"] if equity else None, "to": equity[-1]["t"] if equity else None},
        "equity": equity,
        "daily": sorted(daily.values(), key=lambda x: x["date"]),
        "completedRounds": completed_rounds,
        "stuck": sorted(stuck, key=lambda x: -x["hours"]),
        "crashes": crashes,
        "deposits": deposits,
        "stats": {
            "firstEquity": first_eq, "lastEquity": last_eq,
            "equityDelta": round(last_eq - first_eq, 2) if first_eq and last_eq else None,
            "realizedProfit": total_profit,
            "completedCount": len(completed_rounds),
            "newCount": new_rounds,
            "resetCount": resets_n,
            "resetKilledCount": reset_killed,
            "medianRoundHours": durations[len(durations) // 2] if durations else None,
            "crashRoundCount": sum(1 for r in completed_rounds if r["isCrash"]),
            "idleMedian": sorted(p["idlePct"] for p in equity)[len(equity) // 2] if equity else None,
            "idleCurrent": equity[-1]["idlePct"] if equity else None,
            "avgProfitPerRound": round(total_profit / len(completed_rounds), 2) if completed_rounds else None,
            "resetsInsideRounds": total_resets_in_rounds,
        },
    }

result = {"generatedAt": datetime.now(BEIJING).isoformat(), "timezone": "Asia/Shanghai",
          "instances": {}}
SKIP_DIRS = {"localtest", ".tmp"}
for inst in sorted(os.listdir(RAW)):
    if inst in SKIP_DIRS or inst.startswith("."):
        continue
    if os.path.isdir(os.path.join(RAW, inst)):
        evs = load_events(inst)
        result["instances"][inst] = summarize(inst, evs)

with open(OUT, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=1)
print("written:", OUT)
for inst, s in result["instances"].items():
    print(inst, json.dumps(s["stats"], ensure_ascii=False))
