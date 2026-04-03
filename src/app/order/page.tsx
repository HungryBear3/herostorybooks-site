"use client";
import { useState } from 'react';
import { useRouter } from 'next/navigation';

type OrderData = {
  childName?: string;
  age?: string;
  theme?: string;
  photo: File | undefined;
  customerName?: string;
  email?: string;
  address?: string;
};

export default function OrderPage() {
  const [step, setStep] = useState(0);
  const [data, setData] = useState<OrderData>({ photo: undefined });
  const router = useRouter();

  const next = () => setStep((s) => s + 1);
  const prev = () => setStep((s) => s - 1);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setData((d) => ({ ...d, [name]: value }));
  };
  const handlePhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) setData((d) => ({ ...d, photo: e.target.files![0] }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const form = new FormData();
    Object.entries(data).forEach(([k, v]) => {
      if (v != null) form.append(k, v as any);
    });
    const res = await fetch('/api/order', { method: 'POST', body: form });
    if (res.ok) router.push('/thank-you');
  };

  return (
    <div className="max-w-xl mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">Place Your Order</h1>
      <form onSubmit={handleSubmit} className="space-y-4">
        {step === 0 && (
          <div>
            <label className="block">Child's Name</label>
            <input name="childName" value={data.childName || ''} onChange={handleChange} className="border p-2 w-full" />
            <label className="block mt-2">Age</label>
            <input name="age" type="number" value={data.age || ''} onChange={handleChange} className="border p-2 w-full" />
          </div>
        )}
        {step === 1 && (
          <div>
            <label className="block">Story Theme</label>
            <select name="theme" value={data.theme || ''} onChange={handleChange} className="border p-2 w-full">
              <option value="">Select a theme</option>
              <option value="adventure">Adventure</option>
              <option value="fantasy">Fantasy</option>
              <option value="space">Space</option>
            </select>
          </div>
        )}
        {step === 2 && (
          <div>
            <label className="block">Upload Photo</label>
            <input name="photo" type="file" accept="image/*" onChange={handlePhoto} />
          </div>
        )}
        {step === 3 && (
          <div>
            <label className="block">Your Name</label>
            <input name="customerName" value={data.customerName || ''} onChange={handleChange} className="border p-2 w-full" />
            <label className="block mt-2">Email</label>
            <input name="email" type="email" value={data.email || ''} onChange={handleChange} className="border p-2 w-full" />
            <label className="block mt-2">Address</label>
            <input name="address" value={data.address || ''} onChange={handleChange} className="border p-2 w-full" />
          </div>
        )}
        {step === 4 && (
          <div className="space-y-2 bg-white border p-4 rounded">
            <h2 className="text-xl font-semibold">Order Summary</h2>
            <p><strong>Child:</strong> {data.childName}, Age {data.age}</p>
            <p><strong>Theme:</strong> {data.theme}</p>
            <p><strong>Photo:</strong> {data.photo?.name}</p>
            <p><strong>Name:</strong> {data.customerName}</p>
            <p><strong>Email:</strong> {data.email}</p>
            <p><strong>Address:</strong> {data.address}</p>
            <button type="submit" className="mt-4 px-4 py-2 bg-peach text-white rounded">Place Order</button>
          </div>
        )}
        <div className="flex justify-between">
          {step > 0 && <button type="button" onClick={prev} className="px-4 py-2 border rounded">Back</button>}
          {step < 4 && <button type="button" onClick={next} className="px-4 py-2 bg-purple text-white rounded">Next</button>}
        </div>
      </form>
    </div>
  );
}
