import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { utils } from '@oyster/common';
import * as BufferLayout from 'buffer-layout';
import { GovernanceInstruction } from './governance';

/// [Requires Admin token]
/// Adds a signatory to the Proposal which means that this Proposal can't leave Draft state until yet another signatory burns
/// their signatory token indicating they are satisfied with the instruction queue. They'll receive an signatory token
/// as a result of this call that they can burn later.
///
///   0. `[writable]` Initialized new signatory account.
///   1. `[writable]` Initialized Signatory mint account.
///   2. `[writable]` Admin account.
///   3. `[writable]` Admin validation account.
///   4. `[writable]` Proposal account.
///   5. `[]` Proposal account.
///   6. `[]` Transfer authority
///   7. `[]` Governance program mint authority
///   8. '[]` Token program id.
export const addSignerInstruction = (
  signatoryAccount: PublicKey,
  signatoryMintAccount: PublicKey,
  adminAccount: PublicKey,
  adminValidationAccount: PublicKey,
  proposalStateAccount: PublicKey,
  proposalAccount: PublicKey,
  transferAuthority: PublicKey,
  mintAuthority: PublicKey,
): TransactionInstruction => {
  const PROGRAM_IDS = utils.programIds();

  const dataLayout = BufferLayout.struct([BufferLayout.u8('instruction')]);

  const data = Buffer.alloc(dataLayout.span);

  dataLayout.encode(
    {
      instruction: GovernanceInstruction.AddSigner,
    },
    data,
  );

  const keys = [
    { pubkey: signatoryAccount, isSigner: true, isWritable: true },
    { pubkey: signatoryMintAccount, isSigner: false, isWritable: true },
    { pubkey: adminAccount, isSigner: false, isWritable: true },
    { pubkey: adminValidationAccount, isSigner: false, isWritable: true },
    { pubkey: proposalStateAccount, isSigner: false, isWritable: true },
    { pubkey: proposalAccount, isSigner: false, isWritable: false },
    { pubkey: transferAuthority, isSigner: true, isWritable: false },
    { pubkey: mintAuthority, isSigner: false, isWritable: false },
    { pubkey: PROGRAM_IDS.token, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({
    keys,
    programId: PROGRAM_IDS.governance.programId,
    data,
  });
};
