import React from 'react';
import Image from 'next/image';

const samples = [
  { src: '/sample1.png', caption: 'Adventure in the Forest' },
  { src: '/sample2.png', caption: 'Underwater Quest' },
  { src: '/sample3.png', caption: 'Space Exploration' },
];

export function SampleGallery() {
  return (
    <section className="w-full bg-[var(--cream)] py-20">
      <div className="container mx-auto px-4">
        <h2 className="text-[var(--forest)] text-3xl font-bold text-center mb-10">
          See the Magic
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {samples.map((item, idx) => (
            <div key={idx} className="rounded-2xl overflow-hidden shadow-md">
              <Image
                src={item.src}
                alt={item.caption}
                width={400}
                height={300}
                className="w-full h-auto transform transition hover:scale-[1.03]"
              />
              <p className="text-gray-500 text-center py-2">{item.caption}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
