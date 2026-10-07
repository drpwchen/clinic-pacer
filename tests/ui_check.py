"""UI 冒煙測試＋截圖：用 Playwright 開真的 Edge（有視窗，Document PiP 需要），假時鐘跑一場東基門診。

用法：python tests/ui_check.py <截圖輸出資料夾> [--channel msedge|chrome]
- 按鍵流程：開診、看完（空白鍵／按鈕）、撤銷、空檔、總人數 ±、連按防呆、重新整理不丟狀態、關診。
- 截圖：正常（▲）、落後＋改票預警（▼ 反白）、置頂小視窗（PiP 頁面＋螢幕實拍）。
"""
import argparse
import datetime as dt
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
URL = (ROOT / "clinic-pace.html").as_uri()
TZ = dt.timezone(dt.timedelta(hours=8))
DAY = dt.date(2026, 11, 4)  # 週三，東基門診日


def at(h, m):
    return dt.datetime(DAY.year, DAY.month, DAY.day, h, m, tzinfo=TZ)


def ms(d):
    return int(d.timestamp() * 1000)


def text(page, k):
    return page.inner_text(f'[data-k="{k}"]')


def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        check.failed = True


check.failed = False


def flow(browser):
    ctx = browser.new_context(viewport={"width": 900, "height": 900})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.clock.install(time=at(13, 55))
    page.goto(URL)
    check(text(page, "site") == "東基", "週三 13:55 自動選東基：" + text(page, "site"))
    check("14:00 開診" in text(page, "slack"), "開診前顯示開診時間：" + text(page, "slack"))

    page.clock.fast_forward("05:00")
    page.click('button[data-act="openclose"]')
    check(text(page, "openclose") == "關診", "按開診後按鈕變關診")

    for _ in range(3):
        page.clock.fast_forward("08:00")
        page.keyboard.press(" ")
    check(text(page, "n") == "3", "空白鍵看完 3 位：n=" + text(page, "n"))

    page.click('button[data-act="undo"]')
    check(text(page, "n") == "2", "撤銷後 n=2：" + text(page, "n"))

    page.clock.fast_forward("01:00")
    page.click('button[data-act="idle"]')
    check(page.is_visible('[data-k="idle"]'), "空檔標示出現")
    page.clock.fast_forward("30:00")
    page.click('button[data-act="done"]')
    check(not page.is_visible('[data-k="idle"]'), "看完後空檔標示消失")
    day = json.loads(page.evaluate("localStorage.getItem('clinicpace.v1.day')"))
    ev = day["sessions"]["tch"]["events"]
    check([e["type"] for e in ev] == ["done", "done", "idle", "done"], "事件序列：" + ",".join(e["type"] for e in ev))
    check(set(day["sessions"]["tch"].keys()) == {"N", "openAt", "closedAt", "events"}, "只存人數與按鍵時間：" + ",".join(day["sessions"]["tch"].keys()))
    check(all(set(e.keys()) == {"t", "type"} for e in ev), "事件只有 t/type 兩個欄位")

    page.clock.fast_forward("00:01")
    page.click('button[data-act="done"]')  # 1 秒內連按 → 只算一次
    check(text(page, "n") == "3", "1 秒內連按只算一次：n=" + text(page, "n"))

    page.click('button[data-act="nplus"]')
    check(text(page, "N") == "26", "＋ 後 N=26：" + text(page, "N"))
    page.keyboard.press("-")
    check(text(page, "N") == "25", "- 鍵後 N=25：" + text(page, "N"))

    page.reload()
    check(text(page, "n") == "3" and text(page, "N") == "25", f"重新整理後狀態還在：{text(page, 'n')}/{text(page, 'N')}")

    page.click('button[data-act="openclose"]')
    check("收工" in text(page, "slack"), "關診顯示收工摘要：" + text(page, "slack"))
    page.keyboard.press("Backspace")
    check(text(page, "openclose") == "關診", "Backspace 撤銷關診")

    # 舊瀏覽器退路：#mini 一般小視窗，跟主頁共用 localStorage
    mini = ctx.new_page()
    mini.on("pageerror", lambda e: errors.append(str(e)))
    mini.goto(URL + "#mini")
    check(text(mini, "n") == "3" and mini.locator(".panel").count() == 0, "#mini 小視窗讀到同一份狀態、沒有設定面板")
    mini.click('button[data-act="nplus"]')
    page.wait_for_timeout(300)
    check(text(page, "N") == "26", "#mini 改人數，主頁同步：" + text(page, "N"))
    check(not errors, "沒有 JS 錯誤：" + "; ".join(errors))
    ctx.close()


def no_open_flow(browser):
    """不按開診、直接按看完：第一次看完自動開診，不能多算一段 0 分間隔（verifier 抓到的 bug）。"""
    ctx = browser.new_context(viewport={"width": 900, "height": 900})
    page = ctx.new_page()
    page.clock.install(time=at(14, 10))
    page.goto(URL)
    page.keyboard.press(" ")
    page.clock.fast_forward("07:00")
    page.keyboard.press(" ")
    iv = page.evaluate("""() => { const d = JSON.parse(localStorage.getItem('clinicpace.v1.day'));
        return PaceCore.intervals(d.sessions[d.current]); }""")
    check([round(x, 2) for x in iv] == [7], f"沒按開診：UI 存的狀態間隔＝{iv}（應為 [7]）")
    ctx.close()


def seeded(browser, now, sess, out_png, label, pip_png=None, screen_png=None):
    ctx = browser.new_context(no_viewport=True)
    page = ctx.new_page()
    page.clock.set_fixed_time(now)
    page.goto(URL)
    day = {"date": DAY.isoformat(), "current": "tch", "sessions": {"tch": sess}}
    page.evaluate("d => localStorage.setItem('clinicpace.v1.day', JSON.stringify(d))", day)
    page.reload()
    page.locator("#w").screenshot(path=str(out_png))
    print(f"{label}: n={text(page, 'n')}/{text(page, 'N')} slack={text(page, 'slack')!r} budget={text(page, 'budget')!r} "
          f"warn={text(page, 'warn')!r} train={text(page, 'train')!r} behind={'behind' in page.get_attribute('#w', 'class')}")
    res = {k: text(page, k) for k in ("slack", "budget", "warn", "train")}
    res["behind"] = "behind" in page.get_attribute("#w", "class")
    if pip_png:
        with ctx.expect_page() as pinfo:
            page.click('.panel button[data-act="pip"]')
        pip = pinfo.value
        pip.wait_for_timeout(800)
        res["pip_has_widget"] = pip.evaluate("!!document.getElementById('w')")
        pip.screenshot(path=str(pip_png))
        if screen_png:
            from PIL import ImageGrab
            g = pip.evaluate("({x: screenX, y: screenY, w: outerWidth, h: outerHeight, r: devicePixelRatio})")
            r = g["r"]
            m = 80
            box = (int((g["x"] - m) * r), int((g["y"] - m) * r), int((g["x"] + g["w"] + m) * r), int((g["y"] + g["h"] + m) * r))
            ImageGrab.grab(bbox=box, all_screens=True).save(screen_png)
            res["pip_geom"] = g
        # 關掉 PiP 後小視窗要回到主頁
        pip.close()
        page.wait_for_timeout(500)
        res["widget_back"] = page.evaluate("document.getElementById('host').contains(document.getElementById('w'))")
    ctx.close()
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--channel", default="msedge")
    a = ap.parse_args()
    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    MIN = 60000

    def sess(n_done, end, gap):
        tail = [ms(end) - (5 - i) * gap * MIN for i in range(6)]
        head = [ms(at(14, 0)) + (i + 1) * 9 * MIN for i in range(n_done - 6)]
        return {"N": 25, "openAt": ms(at(14, 0)), "closedAt": None,
                "events": [{"t": t, "type": "done"} for t in head + tail]}

    with sync_playwright() as p:
        browser = p.chromium.launch(channel=a.channel, headless=False)
        flow(browser)
        no_open_flow(browser)
        normal = seeded(browser, at(15, 30), sess(10, at(15, 30), 7), out / "01-normal.png", "正常 15:30",
                        pip_png=out / "03-pip-window.png", screen_png=out / "04-pip-on-screen.png")
        behind = seeded(browser, at(16, 0), sess(12, at(16, 0), 8), out / "02-behind-warn.png", "落後 16:00",
                        pip_png=out / "05-pip-behind.png")
        browser.close()

    check(normal["slack"].startswith("▲ +10") and not normal["behind"], "正常狀態 ▲ +10、不反白：" + normal["slack"])
    check(behind["slack"].startswith("▼ −19") and behind["behind"], "落後狀態 ▼ −19 且反白：" + behind["slack"])
    check("6.5" in behind["budget"], "落後時每位 6.5 分：" + behind["budget"])
    check(behind["warn"] == "照速度趕不上 441 → 現在改 445（18:35）", "改票預警文字：" + behind["warn"])
    check(normal["warn"] == "", "正常時沒有預警")
    check(normal.get("pip_has_widget") and behind.get("pip_has_widget"), "置頂小視窗裡有看診進度")
    check(normal.get("widget_back"), "關掉置頂視窗後回到主頁")
    print("pip geometry:", normal.get("pip_geom"))
    sys.exit(1 if check.failed else 0)


if __name__ == "__main__":
    main()
