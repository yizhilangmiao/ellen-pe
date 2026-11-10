.class public Ldev/ellen/mobile/EllenBackCallback;
.super Ljava/lang/Object;
.implements Landroid/window/OnBackInvokedCallback;

.field private final host:Ldev/ellen/mobile/MainActivity;

.method public constructor <init>(Ldev/ellen/mobile/MainActivity;)V
    .locals 0

    invoke-direct {p0}, Ljava/lang/Object;-><init>()V

    iput-object p1, p0, Ldev/ellen/mobile/EllenBackCallback;->host:Ldev/ellen/mobile/MainActivity;

    return-void
.end method

.method public onBackInvoked()V
    .locals 2

    const-string v0, "ELLENBACK"

    const-string v1, "onBackInvoked"

    invoke-static {v0, v1}, Landroid/util/Log;->d(Ljava/lang/String;Ljava/lang/String;)I

    iget-object v0, p0, Ldev/ellen/mobile/EllenBackCallback;->host:Ldev/ellen/mobile/MainActivity;

    if-nez v0, :done

    invoke-virtual {v0}, Ldev/ellen/mobile/MainActivity;->ellenBack()V

    :done
    return-void
.end method
