import type { InputHTMLAttributes, SelectHTMLAttributes } from "react";

export function Field({ label, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="form-field">
      <span>{label}</span>
      <input {...props} />
    </label>
  );
}

export function SelectField({
  label,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  return (
    <label className="form-field">
      <span>{label}</span>
      <select {...props}>{children}</select>
    </label>
  );
}

export function FormMessage({ error, message }: { error: string; message: string }) {
  if (!error && !message) return null;
  return <p className={error ? "form-message error" : "form-message success"} role="status">{error || message}</p>;
}

export function SubmitButton({ pending, label }: { pending: boolean; label: string }) {
  return <button className="auth-submit" disabled={pending} type="submit">{pending ? "Please wait…" : label}</button>;
}
