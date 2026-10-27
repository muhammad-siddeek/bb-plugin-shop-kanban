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
      className={`inline-flex ${small ? "size-6 rounded-md" : "size-7 rounded-lg"} shrink-0 cursor-pointer select-none items-center justify-center text-muted-foreground transition-[background-color,color,transform] duration-150 ease-out hover:bg-accent hover:text-foreground active:scale-90 active:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 ${className}`}
    >
      <Icon name={icon} className={small ? "size-3.5" : "size-[15px]"} aria-hidden />
    </button>
  );
}
