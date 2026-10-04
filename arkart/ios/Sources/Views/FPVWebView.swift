import SwiftUI
import WebKit

/// Full-screen FPV. WebKit decodes `multipart/x-mixed-replace` MJPEG natively,
/// so there is no frame parsing here — the stream URL goes into an `<img>` and
/// WebKit does the rest (design doc §8).
///
/// The wrapper page exists only to make the image cover the screen and to
/// re-arm itself if the kart drops off the LAN for a moment.
struct FPVWebView: UIViewRepresentable {

    let url: URL
    /// Bump to force a reload (the HUD's reload button).
    let reloadToken: Int

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.suppressesIncrementalRendering = false

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        // Controls live on top of the video; the webview must never eat a touch.
        webView.isUserInteractionEnabled = false
        context.coordinator.load(url, token: reloadToken, into: webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        if context.coordinator.needsReload(url: url, token: reloadToken) {
            context.coordinator.load(url, token: reloadToken, into: webView)
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        private var loadedURL: URL?
        private var loadedToken: Int = .min

        func needsReload(url: URL, token: Int) -> Bool {
            loadedURL != url || loadedToken != token
        }

        func load(_ url: URL, token: Int, into webView: WKWebView) {
            loadedURL = url
            loadedToken = token
            webView.loadHTMLString(FPVPage.html(streamURL: url), baseURL: url)
        }
    }
}
