import Image from "next/image";
import Link from "next/link";

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link className="brand" href="/" aria-label="Authenti8 home">
      <Image src="/logo.png" width={46} height={46} alt="" preload />
      {!compact && <span>Authenti8</span>}
    </Link>
  );
}
