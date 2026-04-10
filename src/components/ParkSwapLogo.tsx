type ParkSwapLogoProps = {
  size?: number;
  className?: string;
};

export function ParkSwapLogo({ size = 40, className }: ParkSwapLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 200 200"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <circle cx="100" cy="100" r="90" fill="#065F46" fillOpacity="0.1" />
      <path
        d="M100 40C100 40 60 70 60 110C60 150 100 160 100 160C100 160 140 150 140 110C140 85 125 65 110 55"
        stroke="#10B981"
        strokeWidth="12"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M95 30L105 40L95 50"
        stroke="#10B981"
        strokeWidth="12"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M100 160V100C100 100 100 80 120 75"
        stroke="#34D399"
        strokeWidth="8"
        strokeLinecap="round"
      />
      <circle cx="145" cy="65" r="5" fill="#34D399" />
    </svg>
  );
}
