import React from 'react';
import Image from 'next/image';

const samples = [
  { src: '/sample1.png', caption: 'Adventure in the Forest' },
  { src: '/sample2.png', caption: 'Underwater Quest' },
  { src: '/sample3.png', caption: 'Space Exploration' },
  { src: '/sample4.png', caption: 'Enchanted Castle' },
];

export function SampleGallery() {
  return (
    <section className="w-full bg-[var(--cream)] py-20">
      <div className="container mx-auto px-4">
        <h2 className="text-[var(--forest)] text-3xl font-bold text-center mb-10">
          See the Magic
        </h2>
        <div className="columns-1 sm:columns-2 md:columns-3 gap-4 [&>div]:break-inside-avoid">
          {samples.map((item, idx) => (
            <div key={idx} className="group relative mb-4 overflow-hidden rounded-2xl shadow-lg">
              <Image
                src={item.src}
                alt={item.caption}
                width={400}
                height={300}
                className="w-full h-auto transform transition duration-300 group-hover:scale-105"
              />
              <div className="absolute inset-0 bg-black bg-opacity-40 opacity-0 transition duration-300 group-hover:opacity-100 flex items-center justify-center">
                <p className="text-white text-lg font-semibold px-2 text-center">{item.caption}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
