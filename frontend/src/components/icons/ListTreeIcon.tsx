// Custom List Tree Icon Component
interface ListTreeIconProps {
  className?: string;
}

export default function ListTreeIcon({ className = "h-4 w-4" }: ListTreeIconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 512 512"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M88 24C88 10.7 98.7 0 112 0s24 10.7 24 24V64h80c13.3 0 24 10.7 24 24s-10.7 24-24 24H136v64h80c13.3 0 24 10.7 24 24s-10.7 24-24 24H136v64h80c13.3 0 24 10.7 24 24s-10.7 24-24 24H136v64h80c13.3 0 24 10.7 24 24s-10.7 24-24 24H136v40c0 13.3-10.7 24-24 24s-24-10.7-24-24V24zM288 64c0-17.7 14.3-32 32-32H480c17.7 0 32 14.3 32 32s-14.3 32-32 32H320c-17.7 0-32-14.3-32-32zm0 128c0-17.7 14.3-32 32-32H480c17.7 0 32 14.3 32 32s-14.3 32-32 32H320c-17.7 0-32-14.3-32-32zm0 128c0-17.7 14.3-32 32-32H480c17.7 0 32 14.3 32 32s-14.3 32-32 32H320c-17.7 0-32-14.3-32-32zm0 128c0-17.7 14.3-32 32-32H480c17.7 0 32 14.3 32 32s-14.3 32-32 32H320c-17.7 0-32-14.3-32-32z" />
    </svg>
  );
}
