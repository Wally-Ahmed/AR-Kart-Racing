import Foundation

// Headless harness for the pilot's Core layer. Compiled for macOS against the
// real SDK and run against tools/selfcheck/stub_server.py, so the 25 Hz input
// loop, the 5 Hz HUD poll, the two HTTP adapters and the SATS decoding are all
// exercised for real — not asserted from a comment.
//
// Everything under Sources/Views (SwiftUI/WebKit/UIKit) needs the iOS SDK and is
// syntax-checked separately by tools/verify.sh.

var failures: [String] = []

func check(_ condition: Bool, _ label: String) {
    if condition {
        print("  PASS  \(label)")
    } else {
        print("  FAIL  \(label)")
        failures.append(label)
    }
}

let port = ProcessInfo.processInfo.environment["ARKART_STUB_PORT"] ?? "38731"
let logPath = ProcessInfo.processInfo.environment["ARKART_STUB_LOG"] ?? "/tmp/arkart-stub.log"

print("== 1. SATS / HUD decoding ==")

let defaults = UserDefaults(suiteName: "arkart.selfcheck")!
defaults.removePersistentDomain(forName: "arkart.selfcheck")
let settings = AppSettings(defaults: defaults)
settings.serverURL = "http://127.0.0.1:\(port)"
settings.kartID = 1

let hudStatements = HUDQuery.statements(kartID: 1)
check(hudStatements.count == 4, "HUD poll is four single statements")
check(hudStatements[0] == "SELECT * FROM progress WHERE kart_id = 1",
      "first statement selects this kart's progress")
check(hudStatements.allSatisfy { !$0.contains(";") },
      "no statement contains ';' — the server rejects multi-statement bodies")

check(Item.parse("boost") == .boost && Item.parse("Leader_Strike") == .leaderStrike
        && Item.parse("slow") == .leaderStrike && Item.parse("4") == .leaderStrike,
      "Item.parse handles name, snake case, kind alias and index")
check(EffectKind.parse("ink") == .ink && EffectKind.parse("SLOW") == .slow,
      "EffectKind.parse is case tolerant")
check(Item.boost.displayName == "Boost" && Item.stun.displayName == "Stun Shot"
        && Item.ink.displayName == "Ink Splat" && Item.dizzy.displayName == "Dizzy Ray"
        && Item.leaderStrike.displayName == "Leader Strike" && Item.shield.displayName == "Shield",
      "Item display names match the spec wording")

// Encodings taken verbatim from a live `arkart` response (SpacetimeDB 2.4.1):
// Option::some = [0, payload], Option::none = [1, []], Timestamp = [micros].
check(SATS.string(SATS.unwrapOption([0, "boost"] as [Any])) == "boost",
      "positional Option::some unwraps")
check(SATS.unwrapOption([1, []] as [Any]) == nil, "positional Option::none unwraps to nil")
check(SATS.tag(of: [0, "leader_strike"] as [Any])?.name == "leader_strike",
      "optional item id reads through to its string")
check(Item.parse(SATS.tag(of: [1, []] as [Any])?.name) == nil, "empty slot stays empty")
check(SATS.string(SATS.unwrapOption(["some": "kart_id"])) == "kart_id",
      "legacy named Option unwraps")
check(SATS.unwrapOption(["none": []]) == nil, "legacy none unwraps to nil")
check(SATS.tag(of: ["boost": []])?.name == "boost", "named sum tag")
check(SATS.tag(of: ["2": []])?.name == "2", "index sum tag")

let liveMicros = 1_789_886_675_212_885 as Int
check(abs((SATS.date([liveMicros] as [Any])?.timeIntervalSince1970 ?? 0)
          - Double(liveMicros) / 1_000_000) < 1,
      "[micros] product timestamp decodes")
check(SATS.date([0, [liveMicros]] as [Any]) != nil, "Option<Timestamp> some decodes")
check(SATS.date([1, []] as [Any]) == nil, "Option<Timestamp> none decodes to nil")
let millis = Date().timeIntervalSince1970 * 1000
check(abs((SATS.date(millis)?.timeIntervalSince1970 ?? 0) - millis / 1000) < 1,
      "bare millisecond timestamps still decode")

let fpvHTML = FPVPage.html(streamURL: URL(string: "http://192.168.8.101/stream")!)
check(fpvHTML.contains("var src = \"http://192.168.8.101/stream\";"),
      "FPV page injects the stream URL as a JS string literal")
check(fpvHTML.contains("<img id=\"fpv\">") && !fpvHTML.contains("src=\"\""),
      "FPV <img> has no broken src attribute")
check(fpvHTML.contains("object-fit:cover"), "FPV image covers the screen")
check(FPVPage.jsStringLiteral("a\"b") == "\"a\\\"b\"", "URL quotes are escaped")

print("== 2. Live loops against the stub server ==")

// Top-level code in main.swift is already @MainActor-isolated, so these
// MainActor calls need no hop.
let engine = PilotEngine(settings: settings)
engine.setTouchThrottle(0.5)
engine.setTouchSteer(-0.25)
engine.start()

try? await Task.sleep(nanoseconds: 2_000_000_000)

let hud = engine.hud
let inkUntil = engine.inkUntil
let sent = engine.inputsSent
let linkUp = engine.linkUp

check(linkUp, "link reported up")
check(hud.placement == 2, "placement decoded (got \(String(describing: hud.placement)))")
check(hud.lap == 1 && hud.lapCount == 3 && hud.lapLabel == "2/3",
      "lap decoded (\(hud.lapLabel))")
check(hud.raceState == "running", "race state decoded (\(hud.raceState))")
check(hud.slot1 == .boost && hud.slot2 == .shield,
      "inventory slots decoded (\(String(describing: hud.slot1)) / \(String(describing: hud.slot2)))")
check(hud.isShielded(), "shield indicator active")
check(hud.isDizzy(), "dizzy effect active")
check(hud.banners().contains(.dizzy), "dizzy banner raised")
check(!hud.banners().contains(.ink), "ink is a screen splat, not a banner")
check(inkUntil != nil, "ink overlay armed for this kart")
if let inkUntil = inkUntil {
    let remaining = inkUntil.timeIntervalSinceNow
    check(remaining > 0 && remaining <= PilotEngine.inkDuration + 0.5,
          "ink overlay window <= 4 s (\(String(format: "%.2f", remaining)) s left)")
}

engine.fire(slot: 1)
try? await Task.sleep(nanoseconds: 400_000_000)
engine.stop()
try? await Task.sleep(nanoseconds: 300_000_000)

print("== 3. Wire format actually sent ==")

let log = (try? String(contentsOfFile: logPath, encoding: .utf8)) ?? ""
let entries: [[String: Any]] = log
    .split(separator: "\n")
    .compactMap { line in
        guard let data = line.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

func paths(_ suffix: String) -> [[String: Any]] {
    entries.filter { ($0["path"] as? String)?.hasSuffix(suffix) ?? false }
}

let inputCalls = paths("/v1/database/arkart/call/set_input")
let sqlCalls = paths("/v1/database/arkart/sql")
let itemCalls = paths("/v1/database/arkart/call/use_item")

check(!inputCalls.isEmpty, "set_input hit /v1/database/arkart/call/set_input")
check(!sqlCalls.isEmpty, "HUD poll hit /v1/database/arkart/sql")
check(!itemCalls.isEmpty, "use_item hit /v1/database/arkart/call/use_item")

// 2 s at 25 Hz and 5 Hz, with generous slack for a Python stub.
check(inputCalls.count >= 35 && inputCalls.count <= 70,
      "set_input rate ~25 Hz over 2 s (sent \(inputCalls.count), engine counter \(sent))")
// 5 Hz x 4 concurrent statements.
check(sqlCalls.count >= 24 && sqlCalls.count <= 80,
      "HUD poll rate ~5 Hz x 4 statements over 2 s (sent \(sqlCalls.count))")

if let body = inputCalls.first?["body"] as? String,
   let data = body.data(using: .utf8),
   let args = (try? JSONSerialization.jsonObject(with: data)) as? [Any] {
    check(args.count == 3, "set_input body is a 3-element JSON array: \(body)")
    check((args.first as? NSNumber)?.intValue == 1, "set_input arg0 is the kart id")
    check(abs(((args[1] as? NSNumber)?.doubleValue ?? -9) - 0.5) < 0.001, "throttle sent as 0.5")
    check(abs(((args[2] as? NSNumber)?.doubleValue ?? -9) + 0.25) < 0.001, "steer sent as -0.25")
} else {
    check(false, "set_input body is valid JSON")
}
check((inputCalls.first?["content_type"] as? String)?.contains("application/json") == true,
      "reducer Content-Type is application/json")

let sqlBodies = Set(sqlCalls.compactMap { $0["body"] as? String })
check(sqlBodies.isSuperset(of: Set(hudStatements)),
      "every HUD statement was POSTed on its own (\(sqlBodies.count) distinct bodies)")
check(sqlBodies.allSatisfy { !$0.contains(";") },
      "no multi-statement SQL body ever left the app")

if let body = itemCalls.first?["body"] as? String,
   let data = body.data(using: .utf8),
   let args = (try? JSONSerialization.jsonObject(with: data)) as? [Any] {
    check(args.count == 2 && (args.first as? NSNumber)?.intValue == 1
            && (args[1] as? NSNumber)?.intValue == 1,
          "use_item body is [kart_id, slot]: \(body)")
} else {
    check(false, "use_item body is valid JSON")
}

// After stop() the app must fall silent (the bridge parks the kart on stale input).
let stopMark = Date().timeIntervalSince1970 - 0.25
let afterStop = inputCalls.filter { (($0["t"] as? NSNumber)?.doubleValue ?? 0) > stopMark }
check(afterStop.isEmpty, "no set_input after stop() — backgrounding parks the kart")

if let live = ProcessInfo.processInfo.environment["ARKART_LIVE_URL"],
   !live.isEmpty, let liveURL = URL(string: live) {
    print("== 4. Against the LIVE arkart module ==")
    let liveClient = STDBClient(baseURL: liveURL, module: "arkart", timeout: 5)
    do {
        let tables = try await liveClient.sqlBatch(HUDQuery.statements(kartID: 1))
        check(tables.count == 4, "live server answered 4 statements (got \(tables.count))")
        let columnSets = tables.map { $0.columns }
        check(columnSets.contains { $0.contains("slot_1") }, "inventory exposes slot_1")
        check(columnSets.contains { $0.contains("placement") }, "progress exposes placement")
        check(columnSets.contains { $0.contains("kind") }, "effect exposes kind")

        let snapshot = HUDQuery.decode(tables, previous: HUDSnapshot())
        check(["setup", "lobby", "countdown", "running", "finished"].contains(snapshot.raceState),
              "live race state is a known value (\(snapshot.raceState))")
        check(snapshot.lapCount >= 1, "live lap_count decoded (\(snapshot.lapCount))")
        check(snapshot.placement != nil, "live placement decoded (\(String(describing: snapshot.placement)))")

        try await liveClient.callReducer("set_input", args: [1, 0.25, -0.5])
        let readback = try await liveClient.sql("SELECT * FROM input")
        let row = readback.first?.rows.first { $0.int("kart_id") == 1 }
        check(abs((row?.double("throttle") ?? -9) - 0.25) < 0.01,
              "live set_input round-trips throttle")
        check(abs((row?.double("steer") ?? -9) + 0.5) < 0.01,
              "live set_input round-trips steer")
        check(row?.date("updated_at") != nil, "live updated_at timestamp decodes")
        try await liveClient.callReducer("set_input", args: [1, 0.0, 0.0])   // leave it parked
    } catch {
        check(false, "live module check failed: \(error)")
    }
}

print("")
if failures.isEmpty {
    print("SELFCHECK PASS — \(entries.count) stub requests observed")
    exit(0)
} else {
    print("SELFCHECK FAIL (\(failures.count)):")
    for failure in failures { print("  - \(failure)") }
    exit(1)
}
