package dev.paws.companion;

import android.app.Activity;
import android.annotation.SuppressLint;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
import android.window.OnBackInvokedDispatcher;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

public class MainActivity extends Activity {
    private WebView web;
    private String origin;

    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);

        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                this::navigateBack
            );
        }

        showConnection();
    }

    private void showConnection() {
        if (web != null) {
            web.destroy();
            web = null;
        }

        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(
            32,
            48,
            32,
            32
        );
        TextView label = new TextView(this);
        label.setText("Paws computer address (HTTPS)");
        EditText address = new EditText(this);
        address.setSingleLine(true);
        address.setInputType(android.text.InputType.TYPE_CLASS_TEXT
            | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        address.setText(getPreferences(MODE_PRIVATE).getString("origin", ""));
        Button connect = new Button(this);
        connect.setText("Connect");
        connect.setOnClickListener(view -> {
            Uri uri = Uri.parse(address.getText().toString().trim());

            if (!"https".equals(uri.getScheme()) || uri.getHost() == null
                || uri.getUserInfo() != null || uri.getQuery() != null
                || uri.getFragment() != null
                || (uri.getPath() != null && !uri.getPath().isEmpty()
                    && !"/".equals(uri.getPath()))) {
                address.setError("Enter an HTTPS address without a path or token.");

                return;
            }

            origin = "https://" + uri.getEncodedAuthority();
            getPreferences(MODE_PRIVATE).edit().putString("origin", origin).apply();
            showWeb();
        });
        layout.addView(label);
        layout.addView(address);
        layout.addView(connect);
        showLayout(layout);
    }

    private boolean sameOrigin(Uri uri) {
        Uri expected = Uri.parse(origin);
        int port = uri.getPort() == -1 ? 443 : uri.getPort();
        int expectedPort = expected.getPort() == -1 ? 443 : expected.getPort();

        return "https".equals(uri.getScheme()) && uri.getUserInfo() == null
            && expected.getHost().equalsIgnoreCase(uri.getHost())
            && port == expectedPort;
    }

    private void showWeb() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        Button computer = new Button(this);
        computer.setText("Change computer / disconnect");
        computer.setOnClickListener(view -> {
            CookieManager.getInstance().removeAllCookies(null);
            CookieManager.getInstance().flush();
            showConnection();
        });
        web = new WebView(this);
        web.setBackgroundColor(Color.WHITE);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();

                if (sameOrigin(uri)) return false;

                if (request.isForMainFrame() && "https".equals(uri.getScheme())) {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                }

                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    showConnection();
                    Toast.makeText(
                        MainActivity.this,
                        "Unable to connect. Check the computer address and HTTPS gateway.",
                        Toast.LENGTH_LONG
                    ).show();
                }
            }
        });
        layout.addView(computer);
        layout.addView(web, new LinearLayout.LayoutParams(
            -1,
            0,
            1
        ));
        showLayout(layout);
        web.loadUrl(origin);
    }

    private void showLayout(LinearLayout layout) {
        LinearLayout container = new LinearLayout(this);
        container.setOrientation(LinearLayout.VERTICAL);
        container.addView(layout, new LinearLayout.LayoutParams(-1, -1));
        container.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(
                    WindowInsets.Type.systemBars() | WindowInsets.Type.ime()
                );
                view.setPadding(
                    bars.left,
                    bars.top,
                    bars.right,
                    bars.bottom
                );
            } else {
                view.setPadding(
                    insets.getSystemWindowInsetLeft(),
                    insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(),
                    insets.getSystemWindowInsetBottom()
                );
            }

            return insets;
        });
        setContentView(container);
    }

    // API 26-32 still use this callback; newer devices use the dispatcher above.
    @SuppressLint("GestureBackNavigation")
    @Override
    public void onBackPressed() {
        navigateBack();
    }

    private void navigateBack() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            showConnection();
        }
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();

        super.onDestroy();
    }
}
