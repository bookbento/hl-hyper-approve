import SquishSwitch from "../reactbits/SquishSwitch/SquishSwitch";

type Props = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
  id?: string;
};

/** App switch: React Bits SquishSwitch in the brand colours. */
export default function BrandSwitch({ checked, onChange, disabled, ariaLabel, id }: Props) {
  return (
    <SquishSwitch
      id={id}
      checked={checked}
      onChange={onChange}
      disabled={disabled}
      ariaLabel={ariaLabel}
      width={48}
      height={28}
      trackColor="#e5e7eb"
      trackOnColor="#183e33"
      thumbColor="#ffffff"
      thumbOnColor="#7ef0c2"
    />
  );
}
