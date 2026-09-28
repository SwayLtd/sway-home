/**
 * One Modbus TCP connection to one device, one request at a time.
 *
 * Many devices (inverters especially) accept only one or two connections and handle one
 * request at a time, so requests queue behind each other on a single socket. A request that
 * goes unanswered closes the socket: a late answer would otherwise be taken for the next one.
 * The next request opens a new connection by itself.
 */

import { connect, type Socket } from 'node:net'
import {
  AduReader,
  frame,
  parseAnswer,
  readPdu,
  writeCoilPdu,
  writeRegisterPdu,
  writeRegistersPdu,
  type ModbusAnswer,
  type Table,
} from '#adapters/modbus_codec'

/** The device answered with a Modbus exception: it is there, and it said no. */
export class ModbusException extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message)
    this.name = 'ModbusException'
  }
}

/** The device did not answer at all, or the connection failed. */
export class ModbusUnreachable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModbusUnreachable'
  }
}

interface Pending {
  transactionId: number
  request: Buffer
  resolve: (answer: ModbusAnswer) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class ModbusClient {
  #socket: Socket | null = null
  #opening: Promise<Socket> | null = null
  #reader = new AduReader()
  #pending: Pending | null = null
  #queue: Promise<unknown> = Promise.resolve()
  #nextId = 1
  #closed = false

  constructor(
    readonly host: string,
    readonly port: number,
    readonly timeoutMs = 2000
  ) {}

  read(unit: number, table: Table, address: number, count: number): Promise<number[] | boolean[]> {
    return this.#enqueue(unit, readPdu(table, address, count)).then((answer) => ('registers' in answer ? answer.registers : 'bits' in answer ? answer.bits : []))
  }

  async writeCoil(unit: number, address: number, on: boolean): Promise<void> {
    await this.#enqueue(unit, writeCoilPdu(address, on))
  }

  async writeRegisters(unit: number, address: number, values: number[]): Promise<void> {
    await this.#enqueue(unit, values.length === 1 ? writeRegisterPdu(address, values[0]!) : writeRegistersPdu(address, values))
  }

  close(): void {
    this.#closed = true
    this.#drop(new ModbusUnreachable('Connexion fermée.'))
  }

  #enqueue(unit: number, pdu: Buffer): Promise<ModbusAnswer> {
    const run = this.#queue.then(() => this.#send(unit, pdu))
    this.#queue = run.catch(() => undefined)
    return run
  }

  async #send(unit: number, pdu: Buffer): Promise<ModbusAnswer> {
    if (this.#closed) throw new ModbusUnreachable('Connexion fermée.')
    const socket = await this.#open()
    const transactionId = this.#nextId
    this.#nextId = (this.#nextId % 0xffff) + 1
    const answer = await new Promise<ModbusAnswer>((resolve, reject) => {
      const timer = setTimeout(() => {
        // An answer arriving now would be taken for the next request: start over.
        this.#drop(new ModbusUnreachable(`Pas de réponse de ${this.host}.`))
      }, this.timeoutMs)
      this.#pending = { transactionId, request: pdu, resolve, reject, timer }
      socket.write(frame(transactionId, unit, pdu))
    })
    if ('exception' in answer) throw new ModbusException(answer.exception, `Modbus : ${answer.message}.`)
    return answer
  }

  #open(): Promise<Socket> {
    if (this.#socket && !this.#socket.destroyed) return Promise.resolve(this.#socket)
    if (this.#opening) return this.#opening
    this.#opening = new Promise<Socket>((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port })
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new ModbusUnreachable(`Pas de réponse de ${this.host}:${this.port}.`))
      }, this.timeoutMs)
      socket.once('connect', () => {
        clearTimeout(timer)
        socket.setNoDelay(true)
        this.#socket = socket
        this.#reader = new AduReader()
        resolve(socket)
      })
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(new ModbusUnreachable(`Connexion refusée par ${this.host}:${this.port} (${error.message}).`))
      })
      socket.on('data', (chunk: Buffer) => this.#onData(socket, chunk))
      socket.on('close', () => {
        if (this.#socket === socket) this.#drop(new ModbusUnreachable(`${this.host} a fermé la connexion.`))
      })
    }).finally(() => {
      this.#opening = null
    })
    return this.#opening
  }

  #onData(socket: Socket, chunk: Buffer): void {
    if (this.#socket !== socket) return
    let adus
    try {
      adus = this.#reader.push(chunk)
    } catch (error) {
      this.#drop(new ModbusUnreachable((error as Error).message))
      return
    }
    for (const adu of adus) {
      const pending = this.#pending
      if (!pending || adu.transactionId !== pending.transactionId) continue
      clearTimeout(pending.timer)
      this.#pending = null
      pending.resolve(parseAnswer(pending.request, adu.pdu))
    }
  }

  #drop(error: Error): void {
    const socket = this.#socket
    this.#socket = null
    socket?.destroy()
    const pending = this.#pending
    this.#pending = null
    if (pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
  }
}
