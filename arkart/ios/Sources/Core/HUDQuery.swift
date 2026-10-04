import Foundation

/// Builds and decodes the SQL that feeds the HUD at 5 Hz.
///
/// Four tiny `SELECT *`s rather than a join: SpacetimeDB's SQL surface is
/// narrow, and its HTTP endpoint takes exactly one statement per request
/// (`Multiple SQL statements are not supported`), so `STDBClient.sqlBatch`
/// fires these four concurrently and stitches the results back in order.
public enum HUDQuery {

    public static func statements(kartID: Int) -> [String] {
        let kart = min(max(kartID, 0), 99)      // it is ours, but never interpolate unclamped
        return [
            "SELECT * FROM progress WHERE kart_id = \(kart)",
            "SELECT * FROM inventory WHERE kart_id = \(kart)",
            "SELECT * FROM effect WHERE kart_id = \(kart)",
            "SELECT * FROM config"
        ]
    }

    /// Maps statement results onto a snapshot. Tables are identified by their
    /// columns first (order-proof) and by position only as a fallback.
    public static func decode(_ tables: [STDBTable], previous: HUDSnapshot) -> HUDSnapshot {
        var progress: STDBTable?
        var inventory: STDBTable?
        var effects: STDBTable?
        var config: STDBTable?

        for table in tables {
            if table.has("next_idx") || table.has("placement") || table.has("last_pass_at") {
                progress = table
            } else if table.has("slot_1") || table.has("slot_2")
                        || table.has("slot1") || table.has("slot2") {
                inventory = table
            } else if table.has("kind") || table.has("multiplier") {
                effects = table
            } else if table.has("state") || table.has("lap_count") {
                config = table
            }
        }

        // Nothing matched (schema without names) → trust statement order.
        if progress == nil, inventory == nil, effects == nil, config == nil, tables.count >= 4 {
            progress = tables[0]
            inventory = tables[1]
            effects = tables[2]
            config = tables[3]
        }

        var snapshot = HUDSnapshot()
        snapshot.lapCount = previous.lapCount
        snapshot.raceState = previous.raceState

        if let row = config?.first {
            if let state = row.tag("state", "race_state") { snapshot.raceState = state.lowercased() }
            if let laps = row.int("lap_count", "lapCount", "laps"), laps > 0 { snapshot.lapCount = laps }
        }

        if let row = progress?.first {
            snapshot.lap = row.int("lap") ?? 0
            snapshot.nextIdx = row.int("next_idx", "nextIdx") ?? 0
            if let place = row.int("placement"), place >= 1 { snapshot.placement = place }
            snapshot.finished = row.date("finished_at", "finishedAt") != nil
        }

        // Live module columns are `slot_1` / `slot_2`, each an Option<String>
        // holding the item id (`boost`, `leader_strike`, …).
        if let row = inventory?.first {
            snapshot.slot1 = Item.parse(row.tag("slot_1", "slot1"))
            snapshot.slot2 = Item.parse(row.tag("slot_2", "slot2"))
        }

        if let effects = effects {
            let now = Date()
            snapshot.effects = effects.rows.compactMap { row -> ActiveEffect? in
                guard let kind = EffectKind.parse(row.tag("kind", "effect_kind")) else { return nil }
                let effect = ActiveEffect(
                    rowID: row.int("id", "effect_id"),
                    kind: kind,
                    multiplier: row.double("multiplier") ?? 1.0,
                    expiresAt: row.date("expires_at", "expiresAt")
                )
                // The module's `tick()` sweeps expired rows; drop stragglers so a
                // late sweep never leaves a stale banner on screen.
                return effect.isActive(at: now) ? effect : nil
            }
        }

        snapshot.updatedAt = Date()
        return snapshot
    }
}
