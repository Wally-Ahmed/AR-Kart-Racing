import Foundation

/// The one-page wrapper WKWebView loads for the FPV feed.
///
/// WebKit decodes `multipart/x-mixed-replace` MJPEG natively, so all this page
/// does is make the image cover the screen and re-arm itself if the kart blinks
/// off the LAN. Kept out of the view file so it can be type-checked and tested
/// without the iOS SDK.
public enum FPVPage {

    public static func html(streamURL: URL) -> String {
        let js = jsStringLiteral(streamURL.absoluteString)
        return """
        <!doctype html>
        <html>
        <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
        <style>
          html, body { margin:0; padding:0; height:100%; background:#000; overflow:hidden; }
          #fpv { position:fixed; top:0; left:0; width:100%; height:100%;
                 object-fit:cover; background:#000; }
        </style>
        </head>
        <body>
        <img id="fpv">
        <script>
          // The URL is injected as a JS string literal and assigned to .src, so
          // it is never spliced into an HTML attribute.
          var src = \(js);
          var img = document.getElementById('fpv');
          function rearm() {
            img.src = src + (src.indexOf('?') < 0 ? '?' : '&') + 'r=' + Date.now();
          }
          img.onerror = function () { setTimeout(rearm, 1000); };
          img.src = src;
        </script>
        </body>
        </html>
        """
    }

    /// A safely quoted JavaScript string literal, quotes included.
    ///
    /// `<`, `>` and `&` are escaped as well, so a stream URL can never close the
    /// `<script>` element it sits inside.
    public static func jsStringLiteral(_ value: String) -> String {
        var out = "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"":       out += "\\\""
            case "\\":       out += "\\\\"
            case "\n":       out += "\\n"
            case "\r":       out += "\\r"
            case "\u{2028}": out += "\\u2028"
            case "\u{2029}": out += "\\u2029"
            case "<":        out += "\\u003C"
            case ">":        out += "\\u003E"
            case "&":        out += "\\u0026"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04X", scalar.value)
                } else {
                    out.append(Character(scalar))
                }
            }
        }
        return out + "\""
    }
}
