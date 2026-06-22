import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { FaLock, FaEye, FaEyeSlash, FaCheck, FaTimes } from "react-icons/fa";
import toast from "react-hot-toast";

interface PasswordStrength {
  level: 'weak' | 'medium' | 'strong';
  label: string;
  color: string;
  bgColor: string;
}

export default function FirstTimePasswordChange() {
  const navigate = useNavigate();
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [passwordStrength, setPasswordStrength] = useState<PasswordStrength | null>(null);
  const [passwordMismatch, setPasswordMismatch] = useState(false);

  // Password strength calculation
  const calculatePasswordStrength = (password: string): PasswordStrength => {
    if (password.length < 6) {
      return {
        level: 'weak',
        label: 'Weak',
        color: 'text-red-600',
        bgColor: 'bg-red-100'
      };
    }

    const hasLetters = /[a-zA-Z]/.test(password);
    const hasNumbers = /\d/.test(password);
    const hasSpecialChars = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password);

    if (password.length >= 8 && hasLetters && hasNumbers && hasSpecialChars) {
      return {
        level: 'strong',
        label: 'Strong',
        color: 'text-green-600',
        bgColor: 'bg-green-100'
      };
    }

    if (password.length >= 6 && hasLetters && hasNumbers) {
      return {
        level: 'medium',
        label: 'Medium',
        color: 'text-yellow-600',
        bgColor: 'bg-yellow-100'
      };
    }

    return {
      level: 'weak',
      label: 'Weak',
      color: 'text-red-600',
      bgColor: 'bg-red-100'
    };
  };

  // Update password strength when newPassword changes
  useEffect(() => {
    if (newPassword) {
      setPasswordStrength(calculatePasswordStrength(newPassword));
    } else {
      setPasswordStrength(null);
    }
  }, [newPassword]);

  // Check password mismatch when confirmPassword changes
  useEffect(() => {
    if (confirmPassword && newPassword) {
      setPasswordMismatch(newPassword !== confirmPassword);
    } else {
      setPasswordMismatch(false);
    }
  }, [newPassword, confirmPassword]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (newPassword.length < 6) {
      toast.error("Password must be at least 6 characters long");
      return;
    }

    if (newPassword !== confirmPassword) {
      toast.error("New Password and Confirm New Password do not match");
      return;
    }

    setLoading(true);

    try {
      const response = await fetch("/api/auth/change-first-time-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({ newPassword }),
      });

      if (response.ok) {
        // Keep loading state active and navigate immediately
        toast.success("Password changed successfully!");
        // Navigate immediately without delay
        navigate("/dashboard", { replace: true });
      } else {
        const errorData = await response.json();
        toast.error(errorData.error || "Failed to change password");
        setLoading(false); // Only disable loading on error
      }
    } catch (error) {
      console.error("Error changing password:", error);
      toast.error("Network error. Please try again.");
      setLoading(false); // Only disable loading on error
    }
    // Note: Don't set loading to false on success - let the navigation handle it
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#183E33] to-[#145c4a] flex items-center justify-center p-4 relative">
      {/* Loading Overlay */}
      {loading && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl p-8 shadow-2xl flex flex-col items-center max-w-sm mx-4">
            <div className="animate-spin rounded-full h-12 w-12 border-4 border-[#145c4a] border-t-transparent mb-4"></div>
            <h3 className="text-lg font-semibold text-gray-800 mb-2">Updating Password</h3>
            <p className="text-gray-600 text-center text-sm">
              Please wait while we update your password and redirect you to the dashboard...
            </p>
          </div>
        </div>
      )}

      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-8">
        <div className="text-center mb-8">
          <div className="mx-auto w-16 h-16 bg-gradient-to-r from-[#183E33] to-[#145c4a] rounded-full flex items-center justify-center mb-4">
            <FaLock className="text-white text-2xl" />
          </div>
          <h1 className="text-2xl font-bold text-gray-800 mb-2">
            Change Your Password
          </h1>
          <p className="text-gray-600 text-sm">
            For security reasons, please change your password on first login
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="relative">
            <label htmlFor="newPassword" className="block text-sm font-medium text-gray-700 mb-2">
              New Password
            </label>
            <div className="relative">
              <input
                id="newPassword"
                type={showNewPassword ? "text" : "password"}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                disabled={loading}
                className="w-full pl-4 pr-12 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#145c4a] focus:border-[#145c4a] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                placeholder="Enter new password"
                required
                minLength={6}
              />
              <button
                type="button"
                disabled={loading}
                className="absolute inset-y-0 right-0 pr-3 flex items-center disabled:opacity-50"
                onClick={() => setShowNewPassword(!showNewPassword)}
              >
                {showNewPassword ? (
                  <FaEyeSlash className="h-5 w-5 text-gray-400" />
                ) : (
                  <FaEye className="h-5 w-5 text-gray-400" />
                )}
              </button>
            </div>
            
            {/* Password Strength Indicator */}
            {passwordStrength && (
              <div className="mt-2">
                <div className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${passwordStrength.bgColor} ${passwordStrength.color}`}>
                  {passwordStrength.level === 'strong' && <FaCheck className="mr-1 h-3 w-3" />}
                  {passwordStrength.level === 'weak' && <FaTimes className="mr-1 h-3 w-3" />}
                  Password Strength: {passwordStrength.label}
                </div>
                <div className="mt-1 text-xs text-gray-500">
                  {passwordStrength.level === 'weak' && "Use at least 6 characters"}
                  {passwordStrength.level === 'medium' && "Add special characters for stronger security"}
                  {passwordStrength.level === 'strong' && "Great! Your password is strong"}
                </div>
              </div>
            )}
            
            <p className="text-xs text-gray-500 mt-1">
              Password must be at least 6 characters long
            </p>
          </div>

          <div className="relative">
            <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700 mb-2">
              Confirm New Password
            </label>
            <div className="relative">
              <input
                id="confirmPassword"
                type={showConfirmPassword ? "text" : "password"}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={loading}
                className={`w-full pl-4 pr-12 py-3 border rounded-lg focus:ring-2 focus:ring-[#145c4a] focus:border-[#145c4a] transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                  passwordMismatch ? 'border-red-300 bg-red-50' : 'border-gray-300'
                }`}
                placeholder="Confirm new password"
                required
                minLength={6}
              />
              <button
                type="button"
                disabled={loading}
                className="absolute inset-y-0 right-0 pr-3 flex items-center disabled:opacity-50"
                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
              >
                {showConfirmPassword ? (
                  <FaEyeSlash className="h-5 w-5 text-gray-400" />
                ) : (
                  <FaEye className="h-5 w-5 text-gray-400" />
                )}
              </button>
            </div>
            
            {/* Password Mismatch Error */}
            {passwordMismatch && (
              <div className="mt-2 flex items-center text-red-600 text-sm">
                <FaTimes className="mr-1 h-3 w-3" />
                New Password and Confirm New Password do not match
              </div>
            )}
            
            {/* Password Match Success */}
            {confirmPassword && !passwordMismatch && confirmPassword.length >= 6 && (
              <div className="mt-2 flex items-center text-green-600 text-sm">
                <FaCheck className="mr-1 h-3 w-3" />
                Passwords match
              </div>
            )}
          </div>

          <button
            type="submit"
            disabled={loading || passwordMismatch || newPassword.length < 6}
            className="w-full bg-gradient-to-r from-[#183E33] to-[#145c4a] text-white py-3 px-4 rounded-lg font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
          >
            {loading ? (
              <>
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white mr-2"></div>
                Changing Password...
              </>
            ) : (
              <>
                <FaLock className="mr-2" />
                Change Password
              </>
            )}
          </button>
        </form>

        <div className="mt-6 text-center">
          <p className="text-xs text-gray-500">
            This is a one-time security requirement
          </p>
          
          {/* Password Requirements */}
          <div className="mt-4 p-3 bg-gray-50 rounded-lg">
            <p className="text-xs font-medium text-gray-700 mb-2">Password Requirements:</p>
            <ul className="text-xs text-gray-600 space-y-1">
              <li className="flex items-center">
                <span className="w-2 h-2 bg-gray-400 rounded-full mr-2"></span>
                Weak: Less than 6 characters
              </li>
              <li className="flex items-center">
                <span className="w-2 h-2 bg-yellow-400 rounded-full mr-2"></span>
                Medium: At least 6 characters with letters and numbers
              </li>
              <li className="flex items-center">
                <span className="w-2 h-2 bg-green-400 rounded-full mr-2"></span>
                Strong: At least 8 characters with letters, numbers, and special characters
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}