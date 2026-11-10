.class public Ldev/ellen/mobile/MainActivity;
.super Lcom/getcapacitor/BridgeActivity;
.source "MainActivity.java"


# direct methods
.method public constructor <init>()V
    .locals 0

    .line 31
    invoke-direct {p0}, Lcom/getcapacitor/BridgeActivity;-><init>()V

    return-void
.end method


# virtual methods
.method private findWV(Landroid/view/View;)Landroid/webkit/WebView;
    .locals 4

    if-eqz p1, :ellen_wv_null

    instance-of v0, p1, Landroid/webkit/WebView;

    if-eqz v0, :ellen_wv_group

    move-object v0, p1

    check-cast v0, Landroid/webkit/WebView;

    return-object v0

    :ellen_wv_group
    instance-of v0, p1, Landroid/view/ViewGroup;

    if-eqz v0, :ellen_wv_null

    move-object v0, p1

    check-cast v0, Landroid/view/ViewGroup;

    invoke-virtual {v0}, Landroid/view/ViewGroup;->getChildCount()I

    move-result v1

    const/4 v2, 0x0

    :ellen_wv_loop
    if-ge v2, v1, :ellen_wv_null

    invoke-virtual {v0, v2}, Landroid/view/ViewGroup;->getChildAt(I)Landroid/view/View;

    move-result-object v3

    invoke-direct {p0, v3}, Ldev/ellen/mobile/MainActivity;->findWV(Landroid/view/View;)Landroid/webkit/WebView;

    move-result-object v3

    if-eqz v3, :ellen_wv_next

    return-object v3

    :ellen_wv_next
    add-int/lit8 v2, v2, 0x1

    goto :ellen_wv_loop

    :ellen_wv_null
    const/4 v3, 0x0

    return-object v3
.end method

.method public ellenBack()V
    .locals 4

    const-string v0, "ELLENBACK"

    invoke-virtual {p0}, Ldev/ellen/mobile/MainActivity;->getWindow()Landroid/view/Window;

    move-result-object v1

    invoke-virtual {v1}, Landroid/view/Window;->getDecorView()Landroid/view/View;

    move-result-object v1

    invoke-direct {p0, v1}, Ldev/ellen/mobile/MainActivity;->findWV(Landroid/view/View;)Landroid/webkit/WebView;

    move-result-object v2

    if-eqz v2, :ellen_nobridge

    const-string v3, "javascript:(function(){try{var h=window.__ellenBack;if(typeof h==='function'){h();}else{window.dispatchEvent(new Event('backbutton'));}}catch(e){}})()"

    invoke-virtual {v2, v3}, Landroid/webkit/WebView;->loadUrl(Ljava/lang/String;)V

    const-string v3, "js sent via tree"

    invoke-static {v0, v3}, Landroid/util/Log;->d(Ljava/lang/String;Ljava/lang/String;)I

    return-void

    :ellen_nobridge
    const-string v3, "no webview"

    invoke-static {v0, v3}, Landroid/util/Log;->d(Ljava/lang/String;Ljava/lang/String;)I

    return-void
.end method

.method public onBackPressed()V
    .locals 0

    invoke-virtual {p0}, Ldev/ellen/mobile/MainActivity;->ellenBack()V

    return-void
.end method

.method public onCreate(Landroid/os/Bundle;)V
    .locals 3

    .line 34
    invoke-static {p0}, Ldev/ellen/mobile/platform/EllenDiagnosticsStore;->install(Landroid/content/Context;)V

    .line 35
    const-class v0, Ldev/ellen/mobile/platform/EllenDiagnosticsPlugin;

    invoke-virtual {p0, v0}, Ldev/ellen/mobile/MainActivity;->registerPlugin(Ljava/lang/Class;)V

    .line 36
    const-class v0, Ldev/ellen/mobile/platform/EllenScreenShellPlugin;

    invoke-virtual {p0, v0}, Ldev/ellen/mobile/MainActivity;->registerPlugin(Ljava/lang/Class;)V

    .line 37
    const-class v0, Ldev/ellen/mobile/platform/EllenSecureConfigPlugin;

    invoke-virtual {p0, v0}, Ldev/ellen/mobile/MainActivity;->registerPlugin(Ljava/lang/Class;)V

    .line 38
    const-class v0, Ldev/ellen/mobile/platform/EllenLocalSyncPlugin;

    invoke-virtual {p0, v0}, Ldev/ellen/mobile/MainActivity;->registerPlugin(Ljava/lang/Class;)V

    .line 39
    const-class v0, Ldev/ellen/mobile/platform/EllenVoiceHttpPlugin;

    invoke-virtual {p0, v0}, Ldev/ellen/mobile/MainActivity;->registerPlugin(Ljava/lang/Class;)V

    .line 40
    const-class v0, Ldev/ellen/mobile/platform/EllenModelCatalogHttpPlugin;

    invoke-virtual {p0, v0}, Ldev/ellen/mobile/MainActivity;->registerPlugin(Ljava/lang/Class;)V

    .line 41
    const-class v0, Ldev/ellen/mobile/platform/EllenModelHttpPlugin;

    invoke-virtual {p0, v0}, Ldev/ellen/mobile/MainActivity;->registerPlugin(Ljava/lang/Class;)V

    .line 42
    const-class v0, Ldev/ellen/mobile/platform/EllenFeedbackHttpPlugin;

    invoke-virtual {p0, v0}, Ldev/ellen/mobile/MainActivity;->registerPlugin(Ljava/lang/Class;)V

    .line 43
    const-class v0, Ldev/ellen/mobile/platform/EllenReleaseInfoPlugin;

    invoke-virtual {p0, v0}, Ldev/ellen/mobile/MainActivity;->registerPlugin(Ljava/lang/Class;)V

    .line 44
    const-class v0, Ldev/ellen/mobile/platform/EllenUpdatesPlugin;

    invoke-virtual {p0, v0}, Ldev/ellen/mobile/MainActivity;->registerPlugin(Ljava/lang/Class;)V

    .line 45
    const-class v0, Ldev/ellen/mobile/platform/EllenLicensePlugin;

    invoke-virtual {p0, v0}, Ldev/ellen/mobile/MainActivity;->registerPlugin(Ljava/lang/Class;)V

    .line 46
    const-class v0, Ldev/ellen/mobile/platform/EllenLocalSpeechPlugin;

    invoke-virtual {p0, v0}, Ldev/ellen/mobile/MainActivity;->registerPlugin(Ljava/lang/Class;)V

    .line 47
    const-class v0, Ldev/ellen/mobile/platform/EllenBackgroundPlugin;

    invoke-virtual {p0, v0}, Ldev/ellen/mobile/MainActivity;->registerPlugin(Ljava/lang/Class;)V

    .line 48
    const-class v0, Ldev/ellen/mobile/platform/EllenCallSessionPlugin;

    invoke-virtual {p0, v0}, Ldev/ellen/mobile/MainActivity;->registerPlugin(Ljava/lang/Class;)V

    .line 49
    const-class v0, Ldev/ellen/mobile/platform/EllenDocumentsPlugin;

    invoke-virtual {p0, v0}, Ldev/ellen/mobile/MainActivity;->registerPlugin(Ljava/lang/Class;)V

    .line 50
    const-class v0, Ldev/ellen/mobile/platform/EllenArchivePlugin;

    invoke-virtual {p0, v0}, Ldev/ellen/mobile/MainActivity;->registerPlugin(Ljava/lang/Class;)V

    .line 51
    const-class v0, Ldev/ellen/mobile/platform/EllenAutonomyPlugin;

    invoke-virtual {p0, v0}, Ldev/ellen/mobile/MainActivity;->registerPlugin(Ljava/lang/Class;)V

    .line 52
    const-class v0, Ldev/ellen/mobile/media/EllenMediaPlugin;

    invoke-virtual {p0, v0}, Ldev/ellen/mobile/MainActivity;->registerPlugin(Ljava/lang/Class;)V

    .line 53
    const-class v0, Ldev/ellen/mobile/audio/EllenAudioPlugin;

    invoke-virtual {p0, v0}, Ldev/ellen/mobile/MainActivity;->registerPlugin(Ljava/lang/Class;)V

    .line 54
    const-class v0, Ldev/ellen/mobile/audio/EllenMusicPlugin;

    invoke-virtual {p0, v0}, Ldev/ellen/mobile/MainActivity;->registerPlugin(Ljava/lang/Class;)V

    .line 55
    const-class v0, Ldev/ellen/mobile/audio/EllenCallCapturePlugin;

    invoke-virtual {p0, v0}, Ldev/ellen/mobile/MainActivity;->registerPlugin(Ljava/lang/Class;)V

    .line 56
    const-class v0, Ldev/ellen/mobile/audio/EllenCallProbePlugin;

    invoke-virtual {p0, v0}, Ldev/ellen/mobile/MainActivity;->registerPlugin(Ljava/lang/Class;)V

    .line 57
    invoke-super {p0, p1}, Lcom/getcapacitor/BridgeActivity;->onCreate(Landroid/os/Bundle;)V

    .line 60
    invoke-static {p0}, Ldev/ellen/mobile/platform/EllenScreenShellPlugin;->prepareWindow(Landroid/app/Activity;)V

    :try_start_ellen
    invoke-virtual {p0}, Landroid/app/Activity;->getOnBackInvokedDispatcher()Landroid/window/OnBackInvokedDispatcher;

    move-result-object v0

    new-instance v0, Ldev/ellen/mobile/EllenBackCallback;

    invoke-direct {v0, p0}, Ldev/ellen/mobile/EllenBackCallback;-><init>(Ldev/ellen/mobile/MainActivity;)V

    invoke-virtual {p0}, Landroid/app/Activity;->getOnBackInvokedDispatcher()Landroid/window/OnBackInvokedDispatcher;

    move-result-object v1

    const/4 v2, 0x0

    invoke-virtual {v1, v2, v0}, Landroid/window/OnBackInvokedDispatcher;->registerOnBackInvokedCallback(ILandroid/window/OnBackInvokedCallback;)V

    :try_end_ellen
    .catch Ljava/lang/Throwable; {:try_start_ellen .. :try_end_ellen} :ellen_skip

    :ellen_skip
    return-void
.end method

.method public onDestroy()V
    .locals 1

    .line 64
    const-string v0, "native.activity-destroy"

    invoke-static {p0, v0}, Ldev/ellen/mobile/platform/EllenDiagnosticsStore;->lifecycle(Landroid/content/Context;Ljava/lang/String;)V

    invoke-static {p0}, Ldev/ellen/mobile/platform/EllenAutonomyJobService;->uiDestroyed(Ljava/lang/Object;)V

    invoke-super {p0}, Lcom/getcapacitor/BridgeActivity;->onDestroy()V

    return-void
.end method

.method public onPause()V
    .locals 1

    .line 63
    const-string v0, "native.activity-pause"

    invoke-static {p0, v0}, Ldev/ellen/mobile/platform/EllenDiagnosticsStore;->lifecycle(Landroid/content/Context;Ljava/lang/String;)V

    const/4 v0, 0x0

    invoke-static {v0}, Ldev/ellen/mobile/platform/EllenMessageNotifications;->activity(Z)V

    invoke-static {p0}, Ldev/ellen/mobile/platform/EllenAutonomyJobService;->uiPaused(Ljava/lang/Object;)V

    invoke-super {p0}, Lcom/getcapacitor/BridgeActivity;->onPause()V

    return-void
.end method

.method public onResume()V
    .locals 1

    .line 62
    const-string v0, "native.activity-resume"

    invoke-static {p0, v0}, Ldev/ellen/mobile/platform/EllenDiagnosticsStore;->lifecycle(Landroid/content/Context;Ljava/lang/String;)V

    const/4 v0, 0x1

    invoke-static {v0}, Ldev/ellen/mobile/platform/EllenMessageNotifications;->activity(Z)V

    invoke-static {p0}, Ldev/ellen/mobile/platform/EllenAutonomyJobService;->uiResumed(Ljava/lang/Object;)V

    invoke-super {p0}, Lcom/getcapacitor/BridgeActivity;->onResume()V

    return-void
.end method
