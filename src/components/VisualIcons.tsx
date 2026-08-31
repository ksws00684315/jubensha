import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

export function BrandMark(props: IconProps) {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" {...props}>
      <path
        d="M5 6.5c3.2.2 6-1.1 8.2-3.5L16 6l2.8-3c2.2 2.4 5 3.7 8.2 3.5v8.2c0 6.9-4.4 11.6-11 14.3-6.6-2.7-11-7.4-11-14.3V6.5Z"
        fill="currentColor"
        fillOpacity=".16"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M16 6v17.5" stroke="currentColor" strokeWidth="1.2" strokeOpacity=".45" />
      <path d="M8.5 12.2c1.8-1.1 3.8-1 5.4.3-1.6 1.7-3.8 1.8-5.4-.3Z" fill="currentColor" />
      <path d="M23.5 12.2c-1.8-1.1-3.8-1-5.4.3 1.6 1.7 3.8 1.8 5.4-.3Z" fill="currentColor" />
      <path d="M11 20.4c1.3 1.2 2.9 1.8 5 1.8s3.7-.6 5-1.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export type FeatureIconName = "ensemble" | "firewall" | "archive";

export function FeatureIcon({ name, ...props }: IconProps & { name: FeatureIconName }) {
  if (name === "ensemble") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
        <path d="M8.5 10.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z" stroke="currentColor" strokeWidth="1.6" />
        <path d="M3.4 18.8c.4-3.1 2.2-5 5.1-5s4.7 1.9 5.1 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M16.8 8.2h3.8M18.7 6.3v3.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M15.7 13.3c2.6.2 4.2 2 4.6 4.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }

  if (name === "firewall") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
        <path d="M12 2.8 20 6v5.7c0 4.7-2.8 7.8-8 9.6-5.2-1.8-8-4.9-8-9.6V6l8-3.2Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M8.4 11.8 10.8 14l4.9-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path d="M5 4.5h11.5A2.5 2.5 0 0 1 19 7v12.5H7.5A2.5 2.5 0 0 1 5 17V4.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M5 17h11.5M9 8h6M9 11.5h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="m18.5 3 .5 1.2 1.2.5-1.2.5-.5 1.2-.5-1.2-1.2-.5 1.2-.5.5-1.2Z" fill="currentColor" />
    </svg>
  );
}

export function SoundIcon({ muted = false, ...props }: IconProps & { muted?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path d="M4 9.2v5.6h3.4l4.5 3.7v-13L7.4 9.2H4Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      {muted ? (
        <path d="m16 9 4 4m0-4-4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      ) : (
        <>
          <path d="M15.4 9.1c1.5 1.6 1.5 4.2 0 5.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M18.2 6.7c2.8 2.9 2.8 7.7 0 10.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}
