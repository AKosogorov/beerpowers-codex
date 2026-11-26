// Обрабатывает --help до чтения workspace с учётом позиции флага.
// Recognize help only in the command position, before user data or forwarded flags.
export function showHelp(usage, commands = []) {
  const args = process.argv.slice(2);
  if (args.at(-1) === '--help' && (args.length === 1 || (args.length === 2 && commands.includes(args[0])))) {
    console.log(usage);
    process.exit(0);
  }
}
