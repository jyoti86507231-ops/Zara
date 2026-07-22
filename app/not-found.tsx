import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen text-center px-4" id="not-found-container">
      <h2 className="text-2xl font-bold mb-2" id="not-found-heading">Page Not Found</h2>
      <p className="text-gray-600 mb-4" id="not-found-text">Could not find the requested resource.</p>
      <Link 
        href="/" 
        className="px-4 py-2 bg-neutral-900 text-white rounded-md hover:bg-neutral-800 transition"
        id="not-found-home-link"
      >
        Return Home
      </Link>
    </div>
  );
}
