import Image from "next/image";
import Link from "next/link";
import { SiCouchbase } from "react-icons/si";

export default function Header() {
  return (
    <header className="flex flex-col items-center justify-between w-full gap-2 px-2 mt-3 border-b border-gray-500 xs:flex-row pb-7 sm:px-4">
      <Link href="/" className="flex space-x-2">
        <SiCouchbase className="w-10 h-10 text-amber-600" />
        <h1 className="ml-2 text-xl font-bold tracking-tight text-blue-500 sm:text-3xl">
          Cus<span className='font-bold'>Room</span>.
        </h1>
      </Link>

    </header>
  );
}
