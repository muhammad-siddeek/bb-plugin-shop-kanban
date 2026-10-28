import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";

export function IconButton({ icon, label, onClick, small = false, className = "" }: {
  icon: string;
  label: string;
  onClick: () => void;
  small?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`inline-flex ${small ? "size-6 rounded-md pointer-coarse:size-8" : "h-7 w-10 rounded-lg pointer-coarse:h-11 pointer-coarse:w-14"} shrink-0 cursor-pointer select-none items-center justify-center text-muted-foreground transition-[background-color,color,transform] duration-150 ease-out hover:bg-accent hover:text-foreground active:scale-90 active:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 ${className}`}
    >
      <Icon name={icon} className={small ? "size-3.5 pointer-coarse:size-4" : "size-[15px] pointer-coarse:size-5"} aria-hidden />
    </button>
  );
}
