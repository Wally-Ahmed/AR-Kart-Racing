import Foundation

/// Tolerant reader for SpacetimeDB's SATS-JSON encoding.
///
/// The HTTP SQL endpoint answers with `[{ "schema": <ProductType>, "rows": [...] }, ...]`
/// where every row is a JSON-encoded `ProductValue`. In SATS-JSON a product is a
/// positional JSON **array**, an optional is `{"some": v}` / `{"none": []}`, and a
/// sum (enum) is a single-key object tagged by variant name *or* index.
///
/// Servers/SDK versions differ in small ways (rows sometimes arrive as objects
/// keyed by column name, timestamps as micros or millis, enums by name or index),
/// so every accessor here accepts every shape we might meet. This is the ONE
/// place to fix if the wire format ever moves.
public enum SATS {

    // MARK: - Option

    /// Unwraps an optional field to its payload, or nil.
    ///
    /// The live `arkart` module (SpacetimeDB 2.4.1) encodes a sum **positionally**:
    /// `Option::some(v)` is `[0, v]` and `Option::none` is `[1, []]` — confirmed
    /// against a real `POST /v1/database/arkart/sql` response, e.g.
    /// `finished_at` → `[1,[]]`, `slot_1` → `[0,"boost"]`.
    /// The named form `{"some": v}` / `{"none": []}` is accepted too, since older
    /// server builds emit that.
    ///
    /// A one-element array is a single-field product — notably a Timestamp
    /// (`[1789886675212885]` micros) — and is passed straight through for
    /// `numeric`/`date` to read.
    public static func unwrapOption(_ value: Any?) -> Any? {
        guard let value = value else { return nil }
        if value is NSNull { return nil }

        // Positional sum: [tag_index, payload]
        if let array = value as? [Any], array.count == 2, let tag = array[0] as? NSNumber {
            switch tag.intValue {
            case 0: return array[1] is NSNull ? nil : array[1]   // some
            case 1: return nil                                   // none
            default: return value
            }
        }

        if let dict = value as? [String: Any], dict.count == 1 {
            if let some = dict["some"] { return some is NSNull ? nil : some }
            if dict["none"] != nil { return nil }
        }

        // Anything else (including an index-tagged sum like `{"2": []}`) is
        // passed through untouched — `tag(of:)` deals with those.
        return value
    }

    // MARK: - Sum / enum

    /// Returns the variant tag (and payload) of a sum value.
    /// `{"Boost": []}` → ("Boost", []) · `{"3": []}` → ("3", []) · `"boost"` → ("boost", nil)
    public static func tag(of value: Any?) -> (name: String, payload: Any?)? {
        guard let value = unwrapOption(value) else { return nil }
        if let s = value as? String { return (s, nil) }
        if let dict = value as? [String: Any], let key = dict.keys.first, dict.count == 1 {
            return (key, dict[key])
        }
        if let n = numeric(value) { return (String(Int(n)), nil) }
        return nil
    }

    // MARK: - Scalars

    public static func string(_ value: Any?) -> String? {
        guard let value = unwrapOption(value) else { return nil }
        if let s = value as? String { return s }
        if let n = value as? NSNumber { return n.stringValue }
        if let t = tag(of: value) { return t.name }
        return nil
    }

    public static func numeric(_ value: Any?) -> Double? {
        guard let value = unwrapOption(value) else { return nil }
        if let d = value as? Double { return d }
        if let i = value as? Int { return Double(i) }
        if let n = value as? NSNumber { return n.doubleValue }
        if let s = value as? String { return Double(s) }
        // Some encodings box a scalar in a one-key object, e.g.
        // `{"__timestamp_micros_since_unix_epoch__": 1726790400000000}`.
        if let dict = value as? [String: Any], dict.count == 1, let inner = dict.values.first {
            if inner is [String: Any] { return nil }
            return numeric(inner)
        }
        if let arr = value as? [Any], arr.count == 1 { return numeric(arr[0]) }
        return nil
    }

    public static func int(_ value: Any?) -> Int? {
        guard let d = numeric(value), d.isFinite else { return nil }
        return Int(d)
    }

    public static func double(_ value: Any?) -> Double? { numeric(value) }

    public static func bool(_ value: Any?) -> Bool? {
        guard let value = unwrapOption(value) else { return nil }
        if let b = value as? Bool { return b }
        if let n = numeric(value) { return n != 0 }
        if let s = string(value) { return ["true", "1", "yes"].contains(s.lowercased()) }
        return nil
    }

    /// Timestamps arrive as a bare integer whose unit depends on the module's
    /// choice (SpacetimeDB `Timestamp` is micros since the epoch; a module that
    /// just stores `Date.now()` in TS produces millis). Pick the unit by
    /// magnitude — unambiguous for any date this decade.
    public static func date(_ value: Any?) -> Date? {
        guard let n = numeric(value), n > 0, n.isFinite else { return nil }
        if n > 1e17 { return Date(timeIntervalSince1970: n / 1e9) }   // nanoseconds
        if n > 1e14 { return Date(timeIntervalSince1970: n / 1e6) }   // microseconds
        if n > 1e11 { return Date(timeIntervalSince1970: n / 1e3) }   // milliseconds
        return Date(timeIntervalSince1970: n)                          // seconds
    }
}

/// One decoded row: column name → raw SATS value.
public struct SATSRow {
    public let values: [String: Any]

    public init(values: [String: Any]) { self.values = values }

    /// First present value among the given aliases (handles `slot1` vs `slot_1`).
    public func value(_ keys: String...) -> Any? {
        for key in keys {
            if let v = values[key], !(v is NSNull) { return v }
        }
        return nil
    }

    public func string(_ keys: String...) -> String? { SATS.string(firstRaw(keys)) }
    public func int(_ keys: String...) -> Int? { SATS.int(firstRaw(keys)) }
    public func double(_ keys: String...) -> Double? { SATS.double(firstRaw(keys)) }
    public func date(_ keys: String...) -> Date? { SATS.date(firstRaw(keys)) }
    public func tag(_ keys: String...) -> String? { SATS.tag(of: firstRaw(keys))?.name }

    private func firstRaw(_ keys: [String]) -> Any? {
        for key in keys {
            if let v = values[key], !(v is NSNull) { return v }
        }
        return nil
    }
}

/// One statement result from `POST /v1/database/:name/sql`.
public struct STDBTable {
    public let columns: [String]
    public let rows: [SATSRow]

    public init(columns: [String], rows: [SATSRow]) {
        self.columns = columns
        self.rows = rows
    }

    public func has(_ column: String) -> Bool { columns.contains(column) }
    public var first: SATSRow? { rows.first }

    /// Builds a table from one `{"schema": ..., "rows": [...]}` element.
    public static func decode(_ any: Any) -> STDBTable {
        guard let obj = any as? [String: Any] else { return STDBTable(columns: [], rows: []) }
        let columns = Self.columnNames(from: obj["schema"])
        let rawRows = (obj["rows"] as? [Any]) ?? []
        let rows: [SATSRow] = rawRows.map { raw in
            // Positional product (the documented shape).
            if let arr = raw as? [Any] {
                var dict: [String: Any] = [:]
                for (i, v) in arr.enumerated() {
                    let name = i < columns.count ? columns[i] : "col\(i)"
                    dict[name] = v
                }
                return SATSRow(values: dict)
            }
            // Already keyed by column name (some server builds do this).
            if let obj = raw as? [String: Any] { return SATSRow(values: obj) }
            return SATSRow(values: [:])
        }
        return STDBTable(columns: columns, rows: rows)
    }

    /// `ProductType` → ordered column names.
    /// `{"elements":[{"name":{"some":"kart_id"},"algebraic_type":{...}}, ...]}`
    private static func columnNames(from schema: Any?) -> [String] {
        guard let schema = schema as? [String: Any],
              let elements = schema["elements"] as? [Any] else { return [] }
        return elements.enumerated().map { index, element in
            guard let element = element as? [String: Any] else { return "col\(index)" }
            if let name = SATS.string(SATS.unwrapOption(element["name"])) { return name }
            return "col\(index)"
        }
    }
}
