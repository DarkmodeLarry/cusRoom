import Image from "next/image";
import Link from "next/link";
import Header from "../components/Header";
import SquigglyLines from "../components/SquigglyLines";

export default function HomePage() {
  return (
    <div className="flex flex-col items-center justify-center max-w-6xl min-h-screen py-2 mx-auto">
      <Header />
      <main className="flex flex-col items-center justify-center flex-1 w-full px-4 mt-20 text-center sm:mt-20 background-gradient">
        <a
          href="https://vercel.fyi/roomGPT"
          target="_blank"
          rel="noreferrer"
          className="px-4 py-2 mb-5 text-sm text-gray-400 transition duration-300 ease-in-out border border-gray-700 rounded-lg"
        >
          Deployed with{" "}
          <span className="text-blue-600">Vercel</span>
        </a>
        <h1 className="max-w-4xl mx-auto text-5xl font-bold tracking-normal text-gray-300 font-display sm:text-7xl">
        <span className='font-bold text-amber-600 '>Generate</span> your own Custom Rooms with CusRoom 
          <span className="relative text-blue-600 whitespace-nowrap">
            <SquigglyLines />
            <span className="relative">using AI</span>
          </span>{" "}
          
        </h1>
        <h2 className="max-w-xl mx-auto mt-12 text-lg leading-7 text-gray-500 sm:text-gray-400">
          Take a picture of your room and see how your room looks in different
          themes.
        </h2>
        <Link
          className="px-4 py-3 mt-8 font-medium text-white transition bg-blue-600 rounded-xl sm:mt-10 hover:bg-blue-500"
          href="/dream"
        >
          <span className='text-lg font-bold text-amber-600 '>Generate</span> your dream room
        </Link>
        <div className="flex flex-col items-center justify-between w-full mt-6 sm:mt-10">
          <div className="flex flex-col mt-4 mb-16 space-y-10">
            <div className="flex flex-col sm:space-x-8 sm:flex-row">
              <div>
                <h3 className="mb-1 text-lg font-medium">Original Room</h3>
                <Image
                  alt="Original photo of a room with roomGPT.io"
                  src="/original-pic.jpg"
                  className="object-cover w-full h-96 rounded-2xl"
                  width={400}
                  height={400}
                />
              </div>
              <div className="mt-8 sm:mt-0">
                <h3 className="mb-1 text-lg font-medium">Generated Room</h3>
                <Image
                  alt="Generated photo of a room with roomGPT.io"
                  width={400}
                  height={400}
                  src="/generated-pic-2.jpg"
                  className="object-cover w-full mt-2 h-96 rounded-2xl sm:mt-0"
                />
              </div>
            </div>
          </div>
        </div>
      </main>
      
    </div>
  );
}
