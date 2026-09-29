import { cn } from "@/components/lib/utils.js";

/**
 * 品牌图形取自 opencode 官方源码（opencode/packages/ui/src/components/logo.tsx 的
 * Mark / Logo），按 zcode UI 的 currentColor 习惯移植为 React 组件：
 * 官方主题变量映射为透明度——weak 0.35、base 0.85、strong 1。
 * 组件名保留 ZCode 前缀，避免跨包重命名风险。
 */

const WEAK_OPACITY = 0.35;
const BASE_OPACITY = 0.85;

export function ZCodeAboutLogo({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="80"
      height="100"
      viewBox="0 0 16 20"
      fill="none"
      className={cn("shrink-0 text-current", className)}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 16H4V8H12V16Z" fill="currentColor" opacity={WEAK_OPACITY} />
      <path d="M12 4H4V16H12V4ZM16 20H0V0H16V20Z" fill="currentColor" />
    </svg>
  );
}

export function ZCodeWordmarkLogo({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="234"
      height="42"
      viewBox="0 0 234 42"
      fill="none"
      className={cn("shrink-0 text-current", className)}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M18 30H6V18H18V30Z" fill="currentColor" opacity={WEAK_OPACITY} />
      <path d="M18 12H6V30H18V12ZM24 36H0V6H24V36Z" fill="currentColor" opacity={BASE_OPACITY} />
      <path d="M48 30H36V18H48V30Z" fill="currentColor" opacity={WEAK_OPACITY} />
      <path
        d="M36 30H48V12H36V30ZM54 36H36V42H30V6H54V36Z"
        fill="currentColor"
        opacity={BASE_OPACITY}
      />
      <path d="M84 24V30H66V24H84Z" fill="currentColor" opacity={WEAK_OPACITY} />
      <path
        d="M84 24H66V30H84V36H60V6H84V24ZM66 18H78V12H66V18Z"
        fill="currentColor"
        opacity={BASE_OPACITY}
      />
      <path d="M108 36H96V18H108V36Z" fill="currentColor" opacity={WEAK_OPACITY} />
      <path
        d="M108 12H96V36H90V6H108V12ZM114 36H108V12H114V36Z"
        fill="currentColor"
        opacity={BASE_OPACITY}
      />
      <path d="M144 30H126V18H144V30Z" fill="currentColor" opacity={WEAK_OPACITY} />
      <path d="M144 12H126V30H144V36H120V6H144V12Z" fill="currentColor" />
      <path d="M168 30H156V18H168V30Z" fill="currentColor" opacity={WEAK_OPACITY} />
      <path d="M168 12H156V30H168V12ZM174 36H150V6H174V36Z" fill="currentColor" />
      <path d="M198 30H186V18H198V30Z" fill="currentColor" opacity={WEAK_OPACITY} />
      <path d="M198 12H186V30H198V12ZM204 36H180V6H198V0H204V36Z" fill="currentColor" />
      <path d="M234 24V30H216V24H234Z" fill="currentColor" opacity={WEAK_OPACITY} />
      <path d="M216 12V18H228V12H216ZM234 24H216V30H234V36H210V6H234V24Z" fill="currentColor" />
    </svg>
  );
}
