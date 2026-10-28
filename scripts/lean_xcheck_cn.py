"""lean 模式的 A 股 / 港股独立第二来源(免费、无需 key),输出 JSON 行给 lean_xcheck.ts。
A 股:baostock(证券宝)日线收盘价 / peTTM / 年度归母净利与营收;港股:AKShare 新浪港股日线收盘价。
用法: python lean_xcheck_cn.py <symbol> <market>
"""
import json
import sys
import datetime as dt


def a_share(symbol, market):
    import baostock as bs
    rows, errors = [], []
    code = f"{market.lower()}.{symbol}"
    lg = bs.login()
    if lg.error_code != "0":
        return rows, [f"baostock login: {lg.error_msg}"]
    try:
        end = dt.date.today().isoformat()
        start = (dt.date.today() - dt.timedelta(days=20)).isoformat()
        rs = bs.query_history_k_data_plus(code, "date,close,peTTM,tradestatus", start_date=start, end_date=end, frequency="d", adjustflag="3")
        data = []
        while rs.error_code == "0" and rs.next():
            data.append(rs.get_row_data())
        data = [d for d in data if d[3] == "1" and d[1]]
        if data:
            d = data[-1]
            rows.append({"key": "price", "period": "最新", "source": "baostock", "value": float(d[1]), "unit": "元", "currency": "CNY", "ref": f"baostock k_data {code} {d[0]} close", "raw": float(d[1]), "rawUnit": "元"})
            if d[2]:
                rows.append({"key": "pe_ttm", "period": "最新", "source": "baostock", "value": float(d[2]), "unit": "倍", "currency": "倍", "ref": f"baostock k_data {code} {d[0]} peTTM", "raw": float(d[2]), "rawUnit": "倍"})
        else:
            errors.append("baostock k_data: 无数据")
        y = dt.date.today().year
        for year in range(y - 1, y - 4, -1):
            for q in (4,):
                rp = bs.query_profit_data(code=code, year=year, quarter=q)
                fields = rp.fields
                while rp.error_code == "0" and rp.next():
                    r = dict(zip(fields, rp.get_row_data()))
                    period = r.get("statDate", f"{year}-12-31")
                    if r.get("netProfit"):
                        pass  # netProfit 含少数股东,口径与归母不同,不参与对照
                    if r.get("MBRevenue"):
                        v = float(r["MBRevenue"])
                        rows.append({"key": "revenue", "period": period, "source": "baostock", "value": v, "unit": "元(归一)", "currency": "CNY", "ref": f"baostock profit_data {code} {period} MBRevenue", "raw": v, "rawUnit": "元"})
        # 季度累计营收 / 归母净利:baostock 只给比率,不给累计绝对值,所以不做
    finally:
        bs.logout()
    return rows, errors


def hk(symbol):
    import akshare as ak
    rows, errors = [], []
    try:
        df = ak.stock_hk_daily(symbol=symbol, adjust="")
        last = df.iloc[-1]
        rows.append({"key": "price", "period": "最新", "source": "sina(akshare)", "value": float(last["close"]), "unit": "港元", "currency": "HKD", "ref": f"akshare stock_hk_daily {symbol} {str(last['date'])[:10]} close", "raw": float(last["close"]), "rawUnit": "港元"})
    except Exception as e:  # noqa: BLE001
        errors.append(f"akshare stock_hk_daily: {e}")
    return rows, errors


def main():
    symbol, market = sys.argv[1], sys.argv[2].upper()
    if market in ("SH", "SZ"):
        rows, errors = a_share(symbol, market)
    elif market == "HK":
        rows, errors = hk(symbol)
    else:
        rows, errors = [], [f"unsupported market {market}"]
    sys.stdout.write(json.dumps({"rows": rows, "errors": errors}, ensure_ascii=False))


if __name__ == "__main__":
    main()
