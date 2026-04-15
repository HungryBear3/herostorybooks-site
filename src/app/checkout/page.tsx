'use client';
import React, { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { motion } from 'framer-motion';

const fadeUp = {
  hidden: { opacity: 0, y: 30 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6 } },
};

export default function CheckoutPage() {
  const [formData, setFormData] = useState({
    bookType: 'printed',
    childName: '',
    childAge: '',
    email: '',
    photoFile: null
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleInputChange = (e) => {
    const { name, value, type, files } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'file' ? files?.[0] : value
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsSubmitting(true);

    // Simulate API call
    setTimeout(() => {
      setIsSubmitting(false);
      setSuccess(true);
      // Redirect to success page after 2 seconds
      setTimeout(() => {
        window.location.href = '/thank-you';
      }, 2000);
    }, 1500);
  };

  return (
    <main className="w-full min-h-screen bg-white py-12 px-4">
      <div className="container mx-auto max-w-2xl">
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={{ visible: { transition: { staggerChildren: 0.1 } } }}
        >
          {/* Header */}
          <motion.div variants={fadeUp} className="text-center mb-12">
            <Link href="/" className="text-gray-600 hover:text-forest transition mb-4 inline-block">
              ← Back to Home
            </Link>
            <h1 className="font-serif text-4xl md:text-5xl text-forest mb-4">
              Create Your Story
            </h1>
            <p className="text-gray-700 text-lg">
              Fill in your details and bring your child's magical adventure to life
            </p>
          </motion.div>

          {/* Form */}
          {!success ? (
            <motion.form
              variants={fadeUp}
              onSubmit={handleSubmit}
              className="bg-white border-2 border-gray-100 rounded-xl p-8 space-y-6"
            >
              {/* Book Type Selection */}
              <div>
                <label className="block text-lg font-semibold text-forest mb-4">
                  Choose Your Format
                </label>
                <div className="grid grid-cols-3 gap-4">
                  {[
                    { value: 'digital', label: 'Digital', icon: '📱' },
                    { value: 'printed', label: 'Printed', icon: '📚' },
                    { value: 'bundle', label: 'Bundle', icon: '⭐' }
                  ].map(option => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setFormData(prev => ({ ...prev, bookType: option.value }))}
                      className={`p-4 rounded-lg border-2 transition text-center cursor-pointer ${
                        formData.bookType === option.value
                          ? 'border-deep-gold bg-deep-gold/10'
                          : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      <div className="text-3xl mb-2">{option.icon}</div>
                      <div className="font-semibold text-sm">{option.label}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Child Name */}
              <div>
                <label htmlFor="childName" className="block text-lg font-semibold text-forest mb-2">
                  Child's Name *
                </label>
                <input
                  type="text"
                  id="childName"
                  name="childName"
                  value={formData.childName}
                  onChange={handleInputChange}
                  placeholder="e.g., Emma, Liam, Sofia"
                  required
                  className="w-full px-4 py-3 border-2 border-gray-200 rounded-lg focus:outline-none focus:border-deep-gold transition text-gray-900"
                />
              </div>

              {/* Child Age */}
              <div>
                <label htmlFor="childAge" className="block text-lg font-semibold text-forest mb-2">
                  Child's Age
                </label>
                <input
                  type="number"
                  id="childAge"
                  name="childAge"
                  value={formData.childAge}
                  onChange={handleInputChange}
                  placeholder="e.g., 5"
                  min="1"
                  max="18"
                  className="w-full px-4 py-3 border-2 border-gray-200 rounded-lg focus:outline-none focus:border-deep-gold transition text-gray-900"
                />
              </div>

              {/* Photo Upload (Optional) */}
              <div>
                <label htmlFor="photoFile" className="block text-lg font-semibold text-forest mb-2">
                  Child's Photo <span className="text-gray-500 text-sm font-normal">(optional)</span>
                </label>
                <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center cursor-pointer hover:border-deep-gold transition">
                  <input
                    type="file"
                    id="photoFile"
                    name="photoFile"
                    onChange={handleInputChange}
                    accept="image/*"
                    className="hidden"
                  />
                  <label htmlFor="photoFile" className="cursor-pointer block">
                    <p className="text-gray-600">
                      {formData.photoFile
                        ? `✓ ${formData.photoFile.name}`
                        : '📸 Click to upload or drag and drop'}
                    </p>
                    <p className="text-xs text-gray-500 mt-1">PNG, JPG up to 10MB</p>
                  </label>
                </div>
              </div>

              {/* Email */}
              <div>
                <label htmlFor="email" className="block text-lg font-semibold text-forest mb-2">
                  Email Address *
                </label>
                <input
                  type="email"
                  id="email"
                  name="email"
                  value={formData.email}
                  onChange={handleInputChange}
                  placeholder="your@email.com"
                  required
                  className="w-full px-4 py-3 border-2 border-gray-200 rounded-lg focus:outline-none focus:border-deep-gold transition text-gray-900"
                />
              </div>

              {/* Summary */}
              <div className="bg-lavender p-6 rounded-lg">
                <h3 className="font-semibold text-forest mb-3">Order Summary</h3>
                <div className="space-y-2 text-sm text-gray-700">
                  <div className="flex justify-between">
                    <span>Book Type:</span>
                    <span className="font-semibold capitalize">{formData.bookType}</span>
                  </div>
                  <div className="flex justify-between pt-2 border-t border-gray-300 mt-2">
                    <span>Total:</span>
                    <span className="font-bold text-lg text-deep-gold">
                      {formData.bookType === 'digital' && '$29'}
                      {formData.bookType === 'printed' && '$49'}
                      {formData.bookType === 'bundle' && '$59'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Submit Button */}
              <Button
                type="submit"
                disabled={isSubmitting || !formData.childName || !formData.email}
                className="w-full bg-deep-gold text-white py-4 text-lg font-semibold rounded-lg hover:bg-opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSubmitting ? 'Processing...' : 'Continue to Payment'}
              </Button>

              <p className="text-xs text-center text-gray-500 mt-4">
                Your information is secure and never shared with third parties.
              </p>
            </motion.form>
          ) : (
            /* Success State */
            <motion.div
              variants={fadeUp}
              className="bg-green-50 border-2 border-green-200 rounded-xl p-12 text-center"
            >
              <div className="text-5xl mb-4">✨</div>
              <h2 className="font-serif text-3xl text-forest mb-2">
                Order Received!
              </h2>
              <p className="text-gray-700 mb-6">
                Thank you for creating a magical story for {formData.childName}!
              </p>
              <p className="text-gray-600 mb-4">
                Redirecting you to complete payment...
              </p>
            </motion.div>
          )}
        </motion.div>
      </div>
    </main>
  );
}
