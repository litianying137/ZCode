import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { XIcon, Smartphone, LoaderIcon, CheckCircle2Icon, AlertTriangleIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog.js";

interface RemoteControlState {
  state: string;
  qrUrl: string | null;
  deviceSid: string | null;
  error: string | null;
}

declare global {
  interface Window {
    webRemoteControl?: {
      start: () => Promise<RemoteControlState>;
      stop: () => Promise<void>;
      getState: () => Promise<RemoteControlState>;
      onState: (cb: (status: RemoteControlState) => void) => () => void;
    };
  }
}

const STATE_LABELS: Record<string, string> = {
  idle: "未启动",
  connecting: "连接中…",
  registering: "注册中…",
  authenticating: "认证中…",
  waiting_terminal: "已连接，等待手机扫码",
  paired: "已配对",
  error: "错误",
};

export function WebRemoteControlQrDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [status, setStatus] = useState<RemoteControlState>({
    state: "idle",
    qrUrl: null,
    deviceSid: null,
    error: null,
  });
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  // 启动 relay 客户端
  useEffect(() => {
    if (!open) return;
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      // 监听状态
      if (window.webRemoteControl?.onState) {
        unsubscribe = window.webRemoteControl.onState((s) => {
          if (!cancelled) setStatus(s);
        });
      }
      // 启动
      const initial = await window.webRemoteControl?.start();
      if (initial && !cancelled) setStatus(initial);
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [open]);

  // 关闭时停止 relay
  const handleClose = useCallback(() => {
    void window.webRemoteControl?.stop();
    onOpenChange(false);
  }, [onOpenChange]);

  // 生成 QR
  useEffect(() => {
    if (!status.qrUrl) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(status.qrUrl, { margin: 1, width: 240 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [status.qrUrl]);

  const stateLabel = STATE_LABELS[status.state] ?? status.state;
  const isWorking = ["connecting", "registering", "authenticating", "waiting_terminal"].includes(
    status.state,
  );
  const isPaired = status.state === "paired";
  const isError = status.state === "error";

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Smartphone className="size-4" />
            手机远控
          </DialogTitle>
          <DialogDescription>
            扫码或复制链接，在手机浏览器打开即可控制当前工作区。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4 py-2">
          {/* QR */}
          <div className="flex size-60 items-center justify-center rounded-xl border border-border bg-white p-2">
            {qrDataUrl ? (
              <img src={qrDataUrl} alt="QR" className="size-full" />
            ) : isWorking ? (
              <LoaderIcon className="size-8 animate-spin text-foreground-subtle" />
            ) : (
              <span className="text-ui-xs text-foreground-subtle">等待连接…</span>
            )}
          </div>

          {/* 状态 */}
          <div
            className={cn(
              "flex items-center gap-1.5 text-ui-xs",
              isPaired && "text-green-600",
              isError && "text-destructive",
              !isPaired && !isError && "text-foreground-subtle",
            )}
          >
            {isPaired && <CheckCircle2Icon className="size-3.5" />}
            {isError && <AlertTriangleIcon className="size-3.5" />}
            {stateLabel}
            {status.error ? `：${status.error}` : ""}
          </div>

          {/* URL 文本 */}
          {status.qrUrl && (
            <div className="w-full rounded-lg border border-border bg-surface p-2">
              <p className="break-all text-ui-xs text-foreground-subtle">{status.qrUrl}</p>
              <Button
                variant="ghost"
                size="sm"
                className="mt-1 text-ui-xs"
                onClick={() => {
                  if (status.qrUrl) void navigator.clipboard.writeText(status.qrUrl);
                }}
              >
                复制链接
              </Button>
            </div>
          )}
        </div>

        <div className="flex justify-end">
          <Button variant="ghost" onClick={handleClose}>
            <XIcon className="mr-1 size-4" />
            关闭
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
