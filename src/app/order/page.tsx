"use client";
import React, { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';

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
  const [currentStep, setCurrentStep] = useState(1);
  const [formData, setFormData] = useState<OrderData>({ photo: undefined });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const next = () => setCurrentStep((s) => Math.min(s + 1, 5));
  const prev = () => setCurrentStep((s) => Math.max(s - 1, 1));

  const handleChange = (e: React.ChangeEvent<any>) => {
    const { name, value } = e.target;
    setFormData((d) => ({ ...d, [name]: value }));
  };
  const handlePhoto = (file?: File) => {
    if (file) setFormData((d) => ({ ...d, photo: file }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Placeholder for submission
    alert('Checkout coming soon!');
  };

  return (
    <div className="max-w-xl mx-auto p-4">
      <h1 className="text-2xl font-bold mb-6">Place Your Order</h1>
      {/* Progress */}
      <div className="flex justify-center items-center space-x-3 mb-6">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className={`w-4 h-4 rounded-full ${currentStep === i ? 'bg-[var(--gold)]' : 'bg-gray-300'}`} />
        ))}
      </div>
      <form onSubmit={handleSubmit}>
        <AnimatePresence exitBeforeEnter initial={false}>
          {currentStep === 1 && (
            <motion.div
              key="step1"
              initial={{ x: 100, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: -100, opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="space-y-4"
            >
              <h2 className="text-xl font-semibold">About the Child</h2>
              <Input name="childName" placeholder="Child's Name" value={formData.childName || ''} onChange={handleChange} required />
              <Select name="age" onValueChange={(v) => setFormData((d) => ({ ...d, age: v }))}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Age" />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 12 }, (_, i) => (
                    <SelectItem key={i + 1} value={`${i + 1}`}>{i + 1}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div>
                <label className="mr-4">Gender:</label>
                <RadioGroup name="gender" onValueChange={(v) => setFormData((d) => ({ ...d, gender: v }))}>
                  <RadioGroupItem value="male" id="gender-male" /> <label htmlFor="gender-male">Male</label>
                  <RadioGroupItem value="female" id="gender-female" /> <label htmlFor="gender-female">Female</label>
                </RadioGroup>
              </div>
              <Input name="favoriteColor" placeholder="Favorite Color (optional)" onChange={handleChange} />
              <Input name="favoriteAnimal" placeholder="Favorite Animal (optional)" onChange={handleChange} />
            </motion.div>
          )}
          {currentStep === 2 && (
          <div>
            <label className="block">Story Theme</label>
            <select name="theme" value={data.theme || ''} onChange={handleChange} className="border p-2 w-full">
              <option value="">Select a theme</option>
              <option value="adventure">Adventure</option>
              <option value="fantasy">Fantasy</option>
              <option value="space">Space</option>
            </select>
          </div>
            <motion.div
              key="step2"
              initial={{ x: 100, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: -100, opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="space-y-4"
            >
              <h2 className="text-xl font-semibold">Story Customization</h2>
              <div>
                <label className="block mb-1">Book Type</label>
                <RadioGroup name="bookType" onValueChange={(v) => setFormData((d) => ({ ...d, bookType: v }))}>
                  <div className="flex space-x-4">
                    {['Child Hero', 'Mom Tribute', 'Dad Tribute'].map((type) => (
                      <div key={type} className="flex items-center space-x-1">
                        <RadioGroupItem value={type} id={type} />
                        <label htmlFor={type}>{type}</label>
                      </div>
                    ))}
                  </div>
                </RadioGroup>
              </div>
              <Select name="theme" onValueChange={(v) => setFormData((d) => ({ ...d, theme: v }))}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Story Theme" />
                </SelectTrigger>
                <SelectContent>
                  {['Courage', 'Kindness', 'Creativity', 'Adventure', 'Friendship'].map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div>
                <label className="block mb-1">Art Style</label>
                <RadioGroup name="artStyle" onValueChange={(v) => setFormData((d) => ({ ...d, artStyle: v }))}>
                  <div className="flex space-x-4">
                    {['Watercolor', 'Classic Storybook', 'Cartoon'].map((s) => (
                      <div key={s} className="flex items-center space-x-1">
                        <RadioGroupItem value={s} id={s} />
                        <label htmlFor={s}>{s}</label>
                      </div>
                    ))}
                  </div>
                </RadioGroup>
              </div>
              <textarea
                name="specialRequests"
                placeholder="Special requests (optional)"
                className="w-full border p-2 rounded"
                onChange={handleChange}
              />
            </motion.div>
          )}
          {currentStep === 3 && (
          <div>
            <label className="block">Upload Photo</label>
            <input name="photo" type="file" accept="image/*" onChange={handlePhoto} />
          </div>
            <motion.div
              key="step3"
              initial={{ x: 100, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: -100, opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="space-y-4"
            >
              <h2 className="text-xl font-semibold">Upload Photo</h2>
              <div
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-[var(--forest)] border-dashed p-6 text-center cursor-pointer"
              >
                {formData.photo ? (
                  <img
                    src={URL.createObjectURL(formData.photo)}
                    alt="Preview"
                    className="mx-auto max-h-48"
                  />
                ) : (
                  <p>Drag & drop or click to upload (JPEG/PNG, max 10MB)</p>
                )}
                <input
                  type="file"
                  accept="image/jpeg,image/png"
                  className="hidden"
                  ref={fileInputRef}
                  onChange={(e) => e.target.files && handlePhoto(e.target.files[0])}
                />
              </div>
            </motion.div>
          )}
          {currentStep === 4 && (
          <div>
            <label className="block">Your Name</label>
            <input name="customerName" value={data.customerName || ''} onChange={handleChange} className="border p-2 w-full" />
            <label className="block mt-2">Email</label>
            <input name="email" type="email" value={data.email || ''} onChange={handleChange} className="border p-2 w-full" />
            <label className="block mt-2">Address</label>
            <input name="address" value={data.address || ''} onChange={handleChange} className="border p-2 w-full" />
          </div>
            <motion.div
              key="step4"
              initial={{ x: 100, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: -100, opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="space-y-4"
            >
              <h2 className="text-xl font-semibold">Your Information</h2>
              <Input name="customerName" placeholder="Your Name" value={formData.customerName || ''} onChange={handleChange} required />
              <Input name="email" type="email" placeholder="Email" value={formData.email || ''} onChange={handleChange} required />
              {(formData.bookType === 'Printed' || formData.bookType === 'Bundle') && (
                <textarea
                  name="address"
                  placeholder="Shipping Address"
                  className="w-full border p-2 rounded"
                  onChange={handleChange}
                />
              )}
            </motion.div>
          )}
          {currentStep === 5 && (
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
            <motion.div
              key="step5"
              initial={{ x: 100, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: -100, opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="space-y-4"
            >
              <h2 className="text-xl font-semibold">Checkout</h2>
              <div className="bg-white border p-4 rounded">
                <p><strong>Child:</strong> {formData.childName}, Age {formData.age}</p>
                <p><strong>Book Type:</strong> {formData.bookType}</p>
                <p><strong>Theme:</strong> {formData.theme}</p>
                <p><strong>Art Style:</strong> {formData.artStyle}</p>
                <p><strong>Photo:</strong> {formData.photo?.name}</p>
                <p><strong>Name:</strong> {formData.customerName}</p>
                <p><strong>Email:</strong> {formData.email}</p>
                {(formData.bookType === 'Printed' || formData.bookType === 'Bundle') && (
                  <p><strong>Address:</strong> {formData.address}</p>
                )}
              </div>
              <Button disabled className="bg-[var(--gold)] text-[var(--forest)]">
                Coming Soon — Stripe checkout launching soon
              </Button>
            </motion.div>
          )}
        <div className="flex justify-between mt-6">
          {currentStep > 1 && (
            <Button variant="outline" onClick={prev} className="px-4 py-2">
              Back
            </Button>
          )}
          {currentStep < 5 && (
            <Button onClick={next} className="px-4 py-2 bg-[var(--gold)] text-[var(--forest)]">
              Next
            </Button>
          )}
        </div>
        </AnimatePresence>
      </form>
    </div>
  );
}
      </form>
    </div>
  );
}
