#!/usr/bin/env node
/** Offline structural verification of a factory-generated standalone ZIP. No data is uploaded. */
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {verifyStandalonePackage} from '../src/common/package_verify.mjs';
const file=process.argv[2];
if(!file){console.error('Использование: node scripts/verify_package.mjs /путь/к/архиву.zip');process.exit(2)}
try{
 const result=verifyStandalonePackage(await readFile(resolve(file)));
 console.log(JSON.stringify(result,null,2));
}catch(err){console.error('ПРОВЕРКА НЕ ПРОЙДЕНА:',err.message);process.exit(1)}
