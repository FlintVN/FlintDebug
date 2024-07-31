
import {
    StackFrame, Source,
    Variable
} from '@vscode/debugadapter';
import fs = require('fs');
import * as net from 'net';
import { FlintSemaphore } from './flint_semaphone';
import { FlintValueInfo } from './flint_value_info';
import { FlintDataResponse } from './flint_data_response';
import { FlintExceptionInfo } from './flint_exception_info';
import { FlintLineInfo } from './class_loader/flint_line_info'
import { FlintStackFrame } from './class_loader/flint_stack_frame';
import { FlintClassLoader } from './class_loader/flint_class_loader';
import { FlintFieldInfo } from './class_loader/flint_field_info';
import { FlintClient } from './flint_client';

export class FlintClientDebugger {
    private static readonly DBG_CMD_READ_STATUS: number = 0;
    private static readonly DBG_CMD_READ_STACK_TRACE: number = 1;
    private static readonly DBG_CMD_ADD_BKP: number = 2;
    private static readonly DBG_CMD_REMOVE_BKP: number = 3;
    private static readonly DBG_CMD_REMOVE_ALL_BKP: number = 4;
    private static readonly DBG_CMD_RUN: number = 5;
    private static readonly DBG_CMD_STOP: number = 6;
    private static readonly DBG_CMD_RESTART: number = 7;
    private static readonly DBG_CMD_TERMINATE: number = 8;
    private static readonly DBG_CMD_STEP_IN: number = 9;
    private static readonly DBG_CMD_STEP_OVER: number = 10;
    private static readonly DBG_CMD_STEP_OUT: number = 11;
    private static readonly DBG_CMD_SET_EXCP_MODE: number = 12;
    private static readonly DBG_CMD_READ_EXCP_INFO: number = 13;
    private static readonly DBG_CMD_READ_LOCAL: number = 14;
    private static readonly DBG_CMD_WRITE_LOCAL: number = 15;
    private static readonly DBG_CMD_READ_FIELD: number = 16;
    private static readonly DBG_CMD_WRITE_FIELD: number = 17;
    private static readonly DBG_CMD_READ_ARRAY: number = 18;
    private static readonly DBG_CMD_READ_SIZE_AND_TYPE: number = 19;
    private static readonly DBG_CMD_INSTALL_FILE: number = 20;
    private static readonly DBG_CMD_WRITE_FILE_DATA: number = 21;
    private static readonly DBG_CMD_COMPLATE_INSTAL: number = 22;

    private static readonly DBG_STATUS_STOP: number = 0x01;
    private static readonly DBG_STATUS_STOP_SET: number = 0x02;
    private static readonly DBG_STATUS_EXCP: number = 0x04;
    private static readonly DBG_STATUS_RESET: number = 0x80;

    private static readonly DBG_RESP_OK = 0;
    private static readonly DBG_RESP_BUSY = 1;
    private static readonly DBG_RESP_FAIL = 2;
    private static readonly DBG_RESP_UNKNOW = 2;

    private static TCP_TIMEOUT_DEFAULT: number = 200;
    private static READ_STATUS_INVERVAL: number = 100;

    private readonly client: FlintClient;

    private rxResponse?: FlintDataResponse;

    private requestStatusTask?: NodeJS.Timeout;

    private currentStatus: number = FlintClientDebugger.DBG_STATUS_STOP;
    private currentStackFrames?: FlintStackFrame[];
    private currentBreakpoints: FlintLineInfo[] = [];

    private tcpSemaphore = new FlintSemaphore(1);

    private variableReferenceMap = new Map<number, FlintValueInfo>;

    private stopCallback?: (reason?: string) => void;
    private errorCallback?: () => void;
    private closeCallback?: () => void;
    private receivedCallback?: (response: FlintDataResponse) => void;

    public constructor(client: FlintClient) {
        this.client = client;
        this.requestStatusTask = undefined;

        this.client.on('data', (data: Buffer) => {
            if(this.receivedCallback) {
                if(!this.rxResponse) {
                    const cmd = data[0] & 0x7F;
                    const dataLength = data[1] | (data[2] << 8) | (data[3] << 16);
                    const responseCode = data[4];
                    this.rxResponse = new FlintDataResponse(cmd, responseCode, dataLength);
                    if(cmd === FlintClientDebugger.DBG_CMD_READ_STACK_TRACE)
                        this.rxResponse.receivedLength = 0;
                    let index = 0;
                    for(let i = 0; i < (data.length - 5); i++)
                        this.rxResponse.data[index++] = data[i + 5];
                    this.rxResponse.receivedLength = index;
                }
                else {
                    let index = this.rxResponse.receivedLength;
                    for(let i = 0; i < data.length; i++)
                        this.rxResponse.data[index++] = data[i];
                    this.rxResponse.receivedLength = index;
                }
                if(this.rxResponse.receivedLength >= this.rxResponse.data.length) {
                    this.receivedCallback(this.rxResponse);
                    this.rxResponse = undefined;
                    this.receivedCallback = undefined;
                }
            }
        });

        this.client.on('error', (err) => {
            if(this.errorCallback)
                this.errorCallback();
        });

        this.client.on('close', () => {
            if(this.closeCallback) {
                if(this.requestStatusTask) {
                    clearTimeout(this.requestStatusTask);
                    this.requestStatusTask = undefined;
                }
                this.closeCallback();
            }
        });
    }

    public startCheckStatus() {
        const timeoutCallback = async () => {
            if(this.client.isConnect() === false) {
                const resp = await this.sendCmd(Buffer.from([FlintClientDebugger.DBG_CMD_READ_STATUS]));
                if(resp && resp.cmd === FlintClientDebugger.DBG_CMD_READ_STATUS && resp.responseCode === FlintClientDebugger.DBG_RESP_OK) {
                    const status = resp.data[0];
                    if(!(status & FlintClientDebugger.DBG_STATUS_RESET)) {
                        const tmp = this.currentStatus;
                        this.currentStatus = status;
                        if((this.currentStatus & FlintClientDebugger.DBG_STATUS_STOP_SET) && (this.currentStatus & FlintClientDebugger.DBG_STATUS_STOP)) {
                            this.currentStackFrames = undefined;
                            if(this.stopCallback) {
                                let reason = undefined;
                                if(this.currentStatus & FlintClientDebugger.DBG_STATUS_EXCP)
                                    reason = 'exception';
                                this.stopCallback(reason);
                            }
                        }
                        else if((tmp & FlintClientDebugger.DBG_STATUS_STOP) !== (this.currentStatus & FlintClientDebugger.DBG_STATUS_STOP)) {
                            this.currentStackFrames = undefined;
                            if(this.stopCallback && (this.currentStatus & FlintClientDebugger.DBG_STATUS_STOP))
                                this.stopCallback();
                        }
                    }
                }
                this.requestStatusTask = setTimeout(timeoutCallback, FlintClientDebugger.READ_STATUS_INVERVAL);
            }
        };
        this.requestStatusTask = setTimeout(timeoutCallback, FlintClientDebugger.READ_STATUS_INVERVAL);
    }

    private onReceived(callback: (response: FlintDataResponse) => void) {
        this.receivedCallback = callback;
    }

    public onStop(callback: (reason?: string) => void) {
        this.stopCallback = callback;
    }

    public onError(callback: () => void) {
        this.errorCallback = callback;
    }

    public onClose(callback: () => void) {
        this.closeCallback = callback;
    }

    public removeAllListeners() {
        this.stopCallback = undefined;
        this.errorCallback = undefined;
        this.closeCallback = undefined;
    }

    public async connect() {
        await this.client.connect();
    }

    private sendCmd(data: Buffer, timeout: number = FlintClientDebugger.TCP_TIMEOUT_DEFAULT): Promise<FlintDataResponse | undefined> {
        return new Promise((resolve) => {
            this.tcpSemaphore.acquire().then(() => {
                const timeoutTask = setTimeout(() => {
                    this.tcpSemaphore.release();
                    resolve(undefined);
                }, timeout);
                this.onReceived((resp) => {
                    this.tcpSemaphore.release();
                    clearTimeout(timeoutTask);
                    resolve(resp);
                });
                if(!this.client.write(data)) {
                    this.tcpSemaphore.release();
                    clearTimeout(timeoutTask);
                    resolve(undefined);
                }
            });
        });
    }

    public async run(): Promise<boolean> {
        this.currentStackFrames = undefined;
        if(!(this.currentStatus & FlintClientDebugger.DBG_STATUS_STOP))
            return true;
        else {
            const resp = await this.sendCmd(Buffer.from([FlintClientDebugger.DBG_CMD_RUN]));
            if(resp && resp.cmd === FlintClientDebugger.DBG_CMD_RUN && resp.responseCode === FlintClientDebugger.DBG_RESP_OK)
                return true;
            else
                return false;
        }
    }

    public async stop(): Promise<boolean> {
        this.currentStackFrames = undefined;
        if(this.currentStatus & FlintClientDebugger.DBG_STATUS_STOP)
            return true;
        else {
            const resp = await this.sendCmd(Buffer.from([FlintClientDebugger.DBG_CMD_STOP]));
            if(!(resp && resp.cmd === FlintClientDebugger.DBG_CMD_STOP && resp.responseCode === FlintClientDebugger.DBG_RESP_OK))
                return false;
            else
                return true;
        };
    }

    private calcCrc(str: string): number {
        let crc: number = 0;
        for(let i = 0; i < str.length; i++)
            crc += str.charCodeAt(i);
        return crc;
    }

    private putConstUtf8ToBuffer(buff: Buffer, str: string, offset: number): number {
        buff[offset++] = (str.length >>> 0) & 0xFF;
        buff[offset++] = (str.length >>> 8) & 0xFF;
        const crc = this.calcCrc(str);
        buff[offset++] = (crc >>> 0) & 0xFF;
        buff[offset++] = (crc >>> 8) & 0xFF;
        const data = Buffer.from(str);
        data.copy(buff, offset);
        return offset + data.length + 1;
    }

    public async removeAllBreakPoints(): Promise<boolean> {
        const resp = await this.sendCmd(Buffer.from([FlintClientDebugger.DBG_CMD_REMOVE_ALL_BKP]));
        if(resp && resp.cmd === FlintClientDebugger.DBG_CMD_REMOVE_ALL_BKP && resp.responseCode === FlintClientDebugger.DBG_RESP_OK)
            return true;
        else
            return false;
    }

    private getRemoveBreakpointList(lines: number[], source: string): FlintLineInfo[] | undefined {
        const ret: FlintLineInfo[] = [];
        for(let i = 0; i < this.currentBreakpoints.length; i++) {
            if(source === this.currentBreakpoints[i].sourcePath) {
                let isContain = false;
                for(let j = 0; j < lines.length; j++) {
                    if(this.currentBreakpoints[i].line === lines[j]) {
                        isContain = true;
                        break;
                    }
                }
                if(!isContain)
                    ret.push(this.currentBreakpoints[i]);
            }
        }
        return ret;
    }

    private getAddBreakpointList(lines: number[], source: string): FlintLineInfo[] | undefined {
        const ret: FlintLineInfo[] = [];
        for(let i = 0; i < lines.length; i++) {
            let isContain = false;
            for(let j = 0; j < this.currentBreakpoints.length; j++) {
                if(source === this.currentBreakpoints[j].sourcePath && this.currentBreakpoints[j].line === lines[i]) {
                    isContain = true;
                    break;
                }
            }
            if(!isContain) {
                const lineInfo = FlintLineInfo.getLineInfoFromLine(lines[i], source);
                if(lineInfo)
                    ret.push(lineInfo);
                else
                    return undefined;
            }
        }
        return ret;
    }

    private async removeBreakPoints(lineInfo: FlintLineInfo[]): Promise<boolean> {
        for(let i = 0; i < lineInfo.length; i++) {
            const line = lineInfo[i];
            let bufferSize = 1 + 4;
            const className = line.classLoader.thisClass.replace(/\\/g, '/');
            const methodName = line.methodInfo.name;
            const descriptor = line.methodInfo.descriptor;
            bufferSize += 4 + className.length + 1;
            bufferSize += 4 + methodName.length + 1;
            bufferSize += 4 + descriptor.length + 1;

            const txBuff = Buffer.alloc(bufferSize);
            let index = 0;

            /* command code */
            txBuff[index++] = FlintClientDebugger.DBG_CMD_REMOVE_BKP;

            /* pc value */
            txBuff[index++] = (line.pc >>> 0) & 0xFF;
            txBuff[index++] = (line.pc >>> 8) & 0xFF;
            txBuff[index++] = (line.pc >>> 16) & 0xFF;
            txBuff[index++] = (line.pc >>> 24) & 0xFF;

            /* class name */
            index = this.putConstUtf8ToBuffer(txBuff, className, index);

            /* method name */
            index = this.putConstUtf8ToBuffer(txBuff, methodName, index);

            /* descriptor */
            index = this.putConstUtf8ToBuffer(txBuff, descriptor, index);

            const resp = await this.sendCmd(txBuff);
            if(resp && resp.cmd === FlintClientDebugger.DBG_CMD_REMOVE_BKP && resp.responseCode === FlintClientDebugger.DBG_RESP_OK) {
                const index = this.currentBreakpoints.findIndex(item => item === line);
                this.currentBreakpoints.splice(index, 1);
            }
            else
                return false;
        }
        return true;
    }

    private async addBreakPoints(lineInfo: FlintLineInfo[]): Promise<boolean> {
        for(let i = 0; i < lineInfo.length; i++) {
            const line = lineInfo[i];
            let bufferSize = 1 + 4;
            const className = line.classLoader.thisClass.replace(/\\/g, '/');
            const methodName = line.methodInfo.name;
            const descriptor = line.methodInfo.descriptor;
            bufferSize += 4 + className.length + 1;
            bufferSize += 4 + methodName.length + 1;
            bufferSize += 4 + descriptor.length + 1;

            const txBuff = Buffer.alloc(bufferSize);
            let index = 0;

            /* command code */
            txBuff[index++] = FlintClientDebugger.DBG_CMD_ADD_BKP;

            /* pc value */
            txBuff[index++] = (line.pc >>> 0) & 0xFF;
            txBuff[index++] = (line.pc >>> 8) & 0xFF;
            txBuff[index++] = (line.pc >>> 16) & 0xFF;
            txBuff[index++] = (line.pc >>> 24) & 0xFF;

            /* class name */
            index = this.putConstUtf8ToBuffer(txBuff, className, index);

            /* method name */
            index = this.putConstUtf8ToBuffer(txBuff, methodName, index);

            /* descriptor */
            index = this.putConstUtf8ToBuffer(txBuff, descriptor, index);

            const resp = await this.sendCmd(txBuff);
            if(resp && resp.cmd === FlintClientDebugger.DBG_CMD_ADD_BKP && resp.responseCode === FlintClientDebugger.DBG_RESP_OK)
                this.currentBreakpoints.push(line);
            else
                return false;
        }
        return true;
    }

    public async setExceptionBreakPointsRequest(isEnabled: boolean): Promise<boolean> {
        const resp = await this.sendCmd(Buffer.from([FlintClientDebugger.DBG_CMD_SET_EXCP_MODE, isEnabled ? 1 : 0]));
        if(resp && resp.cmd === FlintClientDebugger.DBG_CMD_SET_EXCP_MODE && resp.responseCode === FlintClientDebugger.DBG_RESP_OK)
            return true;
        else
            return false;
    }

    public async readExceptionInfo(): Promise<FlintExceptionInfo | undefined> {
        const resp = await this.sendCmd(Buffer.from([FlintClientDebugger.DBG_CMD_READ_EXCP_INFO]));
        if(resp && resp.cmd === FlintClientDebugger.DBG_CMD_READ_EXCP_INFO && resp.responseCode === FlintClientDebugger.DBG_RESP_OK) {
            let index = 0;
            const typeLength = this.readU16(resp.data, index);
            index += 4;
            const type = resp.data.toString('utf-8', index, index + typeLength);
            index += typeLength + 1;
            const messageLength = this.readU16(resp.data, index);
            index += 4;
            const message = resp.data.toString('utf-8', index, index + messageLength);
            return new FlintExceptionInfo(type, message);
        }
        else
            return undefined;
    }

    public async setBreakPointsRequest(lines: number[], source: string): Promise<boolean> {
        let bkps = this.getRemoveBreakpointList(lines, source);
        if(bkps === undefined)
            return false;
        else if(bkps.length > 0) {
            const value = await this.removeBreakPoints(bkps);
            if(!value)
                return false;
        }
        bkps = this.getAddBreakpointList(lines, source);
        if(bkps === undefined)
            return false;
        else if(bkps.length > 0)
            return await this.addBreakPoints(bkps);
        return true;
    }

    private async readStackFrame(frameId: number): Promise<FlintStackFrame | undefined> {
        const txData: Buffer = Buffer.alloc(5);
        txData[0] = FlintClientDebugger.DBG_CMD_READ_STACK_TRACE;
        txData[1] = frameId & 0xFF;
        txData[2] = (frameId >>> 8) & 0xFF;
        txData[3] = (frameId >>> 16) & 0xFF;
        txData[4] = (frameId >>> 24) & 0xFF;
        const resp = await this.sendCmd(txData);
        if(resp && resp.cmd === FlintClientDebugger.DBG_CMD_READ_STACK_TRACE && resp.responseCode === FlintClientDebugger.DBG_RESP_OK) {
            let index = 0;
            const currentStack = this.readU32(resp.data, index);
            const currentStackIndex = currentStack & 0x7FFFFFFF;
            const isEndStack = (currentStack & 0x80000000) ? true : false;
            if(currentStackIndex !== frameId)
                return undefined;
            index += 4;
            const pc = this.readU32(resp.data, index);
            index += 4;
            const classNameLength = this.readU16(resp.data, index);
            index += 2 + 2;
            const className = resp.data.toString('utf-8', index, index + classNameLength);
            index += classNameLength + 1;
            const nameLength = this.readU16(resp.data, index);
            index += 2 + 2;
            const name = resp.data.toString('utf-8', index, index + nameLength);
            index += nameLength + 1;
            const descriptorLength = this.readU16(resp.data, index);
            index += 2 + 2;
            const descriptor = resp.data.toString('utf-8', index, index + descriptorLength);

            const lineInfo = FlintLineInfo.getLineInfoFromPc(pc, className, name, descriptor);
            if(lineInfo) {
                const methodInfo = lineInfo.methodInfo;
                let localVar = undefined;
                if(methodInfo.attributeCode) {
                    const localVarAttr = methodInfo.attributeCode.getLocalVariables();
                    if(localVarAttr) {
                        localVar = [];
                        for(let i = 0; i < localVarAttr.localVariables.length; i++) {
                            const tmp = localVarAttr.localVariables[i];
                            if(tmp.startPc <= pc && pc < (tmp.startPc + tmp.length))
                                localVar.push(tmp);
                        }
                        if(localVar.length === 0)
                            localVar = undefined;
                    }
                }
                return new FlintStackFrame(frameId, lineInfo, isEndStack, localVar);
            }
        }
        return undefined;
    }

    public async restartRequest(mainClass: string): Promise<boolean> {
        const txBuff = Buffer.alloc(6 + mainClass.length);
        txBuff[0] = FlintClientDebugger.DBG_CMD_RESTART;
        this.putConstUtf8ToBuffer(txBuff, mainClass, 1);
        const resp = await this.sendCmd(txBuff, 5000);
        if(resp && resp.cmd === FlintClientDebugger.DBG_CMD_RESTART && resp.responseCode === FlintClientDebugger.DBG_RESP_OK)
            return true;
        else
            return false;
    }

    public async terminateRequest(includeDebugger: boolean): Promise<boolean> {
        const resp = await this.sendCmd(Buffer.from([FlintClientDebugger.DBG_CMD_TERMINATE, includeDebugger ? 1 : 0]), 5000);
        if(resp && resp.cmd === FlintClientDebugger.DBG_CMD_TERMINATE && resp.responseCode === FlintClientDebugger.DBG_RESP_OK)
            return true;
        else
            return false;
    }

    private async stepRequest(stepCmd: number, stepCodeLength: number): Promise<boolean> {
        this.currentStackFrames = undefined;
        const txData = Buffer.alloc(5);
        txData[0] = stepCmd;
        txData[1] = stepCodeLength & 0xFF;
        txData[2] = (stepCodeLength >>> 8) & 0xFF;
        txData[3] = (stepCodeLength >>> 16) & 0xFF;
        txData[4] = (stepCodeLength >>> 24) & 0xFF;
        const resp = await this.sendCmd(Buffer.from(txData));
        if(resp && resp.cmd === stepCmd && resp.responseCode === FlintClientDebugger.DBG_RESP_OK)
            return true;
        else
            return false;
    }

    public async stepInRequest(): Promise<boolean> {
        if(this.currentStackFrames)
            return await this.stepRequest(FlintClientDebugger.DBG_CMD_STEP_IN, this.currentStackFrames[0].lineInfo.codeLength);
        else {
            const currentPoint = await this.readStackFrame(0);
            if(!currentPoint)
                return false;
            else
                return await this.stepRequest(FlintClientDebugger.DBG_CMD_STEP_IN, currentPoint.lineInfo.codeLength);
        }
    }

    public async stepOverRequest(): Promise<boolean> {
        if(this.currentStackFrames)
            return await this.stepRequest(FlintClientDebugger.DBG_CMD_STEP_OVER, this.currentStackFrames[0].lineInfo.codeLength);
        else {
            const currentPoint = await this.readStackFrame(0);
            if(!currentPoint)
                return false;
            else
                return await this.stepRequest(FlintClientDebugger.DBG_CMD_STEP_OVER, currentPoint.lineInfo.codeLength);
        };
    }

    public async stepOutRequest(): Promise<boolean> {
        return await this.stepRequest(FlintClientDebugger.DBG_CMD_STEP_OUT, 0);
    }

    private getSimpleNames(name: string): string[] {
        const ret: string[] = [];
        let index = 0;
        let simpleName = '';
        while(index < name.length) {
            let arrayCount = 0;
            let ch = name.charAt(index++);
            while(ch === '[') {
                arrayCount++;
                ch = name.charAt(index++);
            }
            if(ch !== 'L') {
                if(ch === 'Z')
                    simpleName = "boolean";
                else if(ch === 'C')
                    simpleName = "char";
                else if(ch === 'F')
                    simpleName = "float";
                else if(ch === 'D')
                    simpleName = "double";
                else if(ch === 'B')
                    simpleName = "byte";
                else if(ch === 'S')
                    simpleName = "short";
                else if(ch === 'I')
                    simpleName = "int";
                else if(ch === 'J')
                    simpleName = "long";
                else
                    simpleName = ch;
            }
            else {
                ch = name.charAt(index++);
                while(ch !== ';') {
                    simpleName += ch;
                    ch = name.charAt(index++);
                }
            }
            if(arrayCount > 0)
                simpleName = simpleName.concat("[]".repeat(arrayCount));
            ret.push(simpleName);
        }
        return ret;
    }

    private getShortenName(name: string): string {
        let dotIndexLastIndex = name.lastIndexOf('\/');
        if(dotIndexLastIndex < 0)
            dotIndexLastIndex = name.lastIndexOf('.');
        if(dotIndexLastIndex >= 0)
            return name.substring(dotIndexLastIndex + 1);
        return name;
    }

    private convertToStackFrame(stackFrames: FlintStackFrame[]): StackFrame[] {
        const ret: StackFrame[] = [];
        for(let i = 0; i < stackFrames.length; i++) {
            const lineInfo = stackFrames[i].lineInfo;
            const src = new Source(lineInfo.classLoader.thisClass + ".java", lineInfo.sourcePath);
            let methodName = lineInfo.classLoader.thisClass;
            let dotIndexLastIndex = methodName.lastIndexOf('\/');
            dotIndexLastIndex = (dotIndexLastIndex < 0) ? 0 : (dotIndexLastIndex + 1);
            methodName = methodName.substring(dotIndexLastIndex, methodName.length);
            methodName += '.' + lineInfo.methodInfo.name + '(';
            const descriptor = lineInfo.methodInfo.descriptor;
            const names = this.getSimpleNames(descriptor.substring(1, descriptor.lastIndexOf(')')));
            for(let i = 0; i < names.length; i++) {
                methodName += this.getShortenName(names[i]);
                if((i + 1) < names.length)
                    methodName += ', ';
            }
            methodName += ')';
            const sf = new StackFrame(stackFrames[i].frameId, methodName, src, lineInfo.line);
            sf.instructionPointerReference = lineInfo.pc.toString();
            ret.push(sf);
        }
        return ret;
    }

    private convertToVariable(valueInfos: FlintValueInfo[]) : Variable[] {
        const ret: Variable[] = [];
        for(let i = 0; i < valueInfos.length; i++) {
            if(this.isPrimType(valueInfos[i].type))
                ret.push({name: valueInfos[i].name, value: valueInfos[i].value.toString(), variablesReference: 0});
            else {
                let value;
                if(typeof valueInfos[i].value === 'string')
                    value = valueInfos[i].value;
                else if(valueInfos[i].reference === 0)
                    value = 'null';
                else {
                    let type = this.getSimpleNames(valueInfos[i].type)[0];
                    type = this.getShortenName(type);
                    if(this.isArrayType(valueInfos[i].type)) {
                        const arrayLength = valueInfos[i].size / this.getElementTypeSize(valueInfos[i].type);
                        type = type.replace('[]', '[' + arrayLength + ']');
                    }
                    value = type;
                }
                ret.push({name: valueInfos[i].name, value: value.toString(), variablesReference: valueInfos[i].reference});
            }
        }
        return ret;
    }

    private addToRefMap(valueInfos: FlintValueInfo[]) {
        for(let i = 0; i < valueInfos.length; i++) {
            if(!this.isPrimType(valueInfos[i].type)) {
                const reference = valueInfos[i].reference;
                if(reference !== 0) {
                    if(!this.variableReferenceMap.has(reference))
                        this.variableReferenceMap.set(reference, valueInfos[i]);
                }
            }
        }
    }

    public async stackFrameRequest(): Promise<StackFrame[] | undefined> {
        if(this.currentStackFrames)
            return this.convertToStackFrame(this.currentStackFrames);
        else {
            const ret: FlintStackFrame[] = [];
            let frameId = 0;
            while(true) {
                const stackFrame = await this.readStackFrame(frameId);
                if(stackFrame && stackFrame.lineInfo.sourcePath) {
                    ret.push(stackFrame);
                    if(stackFrame.isEndFrame) {
                        this.currentStackFrames = ret;
                        return this.convertToStackFrame(this.currentStackFrames);
                    }
                    else
                        frameId++;
                }
                else
                    return undefined;
            }
        }
    }

    private isPrimType(descriptor: string): boolean {
        if(descriptor.length === 1) {
            switch(descriptor) {
                case 'Z':
                case 'C':
                case 'F':
                case 'D':
                case 'B':
                case 'S':
                case 'I':
                case 'J':
                    return true;
                default:
                    return false;
            }
        }
        return false;
    }

    private isArrayType(descriptor: string): boolean {
        if(descriptor.length >= 1) {
            switch(descriptor.charAt(0)) {
                case '[':
                    return true;
                default:
                    return false;
            }
        }
        return false;
    }

    private getElementTypeSize(arrayDescriptor: string): number {
        let index = 0;
        if(arrayDescriptor.charAt(index) === '[')
            index++;
        switch(arrayDescriptor.charAt(index)) {
            case 'Z':
            case 'B':
                return 1;
            case 'C':
            case 'S':
                return 2;
            case 'J':
            case 'D':
                return 8;
            default:
                return 4;
        }
    }

    private binaryToInt32(binary: number): number {
        const buffer = new ArrayBuffer(4);
        const view = new DataView(buffer);
        view.setUint32(0, binary);
        return view.getInt32(0);
    }

    private binaryToFloat32(binary: number): number {
        const buffer = new ArrayBuffer(4);
        const view = new DataView(buffer);
        view.setUint32(0, binary);
        return view.getFloat32(0);
    }

    private binaryToInt64(binary: bigint): bigint {
        const buffer = new ArrayBuffer(8);
        const view = new DataView(buffer);
        view.setUint32(0, Number(binary >> 32n));
        view.setUint32(4, Number(binary >> 0xFFFFFFFFn));
        return view.getBigInt64(0);
    }

    private binaryToFloat64(binary: bigint): number {
        const buffer = new ArrayBuffer(8);
        const view = new DataView(buffer);
        view.setUint32(0, Number(binary >> 32n));
        view.setUint32(4, Number(binary >> 0xFFFFFFFFn));
        return view.getFloat64(0);
    }

    private async readObjSizeAndType(reference: number): Promise<[number, string] | undefined> {
        const txBuff = Buffer.alloc(5);
        txBuff[0] = FlintClientDebugger.DBG_CMD_READ_SIZE_AND_TYPE;
        txBuff[1] = (reference >>> 0) & 0xFF;
        txBuff[2] = (reference >>> 8) & 0xFF;
        txBuff[3] = (reference >>> 16) & 0xFF;
        txBuff[4] = (reference >>> 24) & 0xFF;
        const resp = await this.sendCmd(txBuff);
        if(!(resp && resp.cmd === FlintClientDebugger.DBG_CMD_READ_SIZE_AND_TYPE && resp.responseCode === FlintClientDebugger.DBG_RESP_OK))
            return undefined;
        const size = this.readU32(resp.data, 0);
        const typeLength = this.readU16(resp.data, 4);
        const typeName = resp.data.toString('utf-8', 8, 8 + typeLength);
        return [size, typeName];
    }

    private async readStringValue(strReference: number, isStringBuilder: boolean): Promise<string | undefined> {
        const coder = await this.readField(strReference, new FlintFieldInfo('coder', 'B', 0));
        const value = await this.readField(strReference, new FlintFieldInfo('value', '[B', 0));
        if(coder === undefined || value === undefined)
            return undefined;
        const array = value.reference ? await this.readArray(value.reference, 0, value.size, value.type) : undefined;
        if(array === undefined)
            return undefined;
        let count: number | undefined;
        if(isStringBuilder) {
            const tmp = await this.readField(strReference, new FlintFieldInfo('count', 'I', 0));
            if(tmp == undefined)
                return undefined;
            count = (tmp.value as number) << (coder.value as number);
        }
        else
            count = array.length;
        if(count === undefined)
            return undefined;
        const byteArray: number[] = [];
        if(coder.value === 0) {
            for(let i = 0; i < count; i++)
                byteArray.push((array[i].value as number) & 0xFF);
        }
        else for(let i = 0; i < count; i += 2) {
            const low = (array[i + 0].value as number) & 0xFF;
            const hight = (array[i + 1].value as number) & 0xFF;
            byteArray.push(low | (hight << 8));
        }
        return String.fromCharCode(...byteArray);
    }

    private async checkAndReadString(reference: number, typeName: string): Promise<string | undefined> {
        if(reference && !this.isPrimType(typeName) && !this.isArrayType(typeName)) {
            const className = this.getSimpleNames(typeName)[0];
            const classLoader = FlintClassLoader.load(className);
            let str: string | undefined = undefined;
            if(classLoader.isClassOf('java/lang/String'))
                str = await this.readStringValue(reference, false);
            else if(classLoader.isClassOf('java/lang/AbstractStringBuilder'))
                str = await this.readStringValue(reference, true);
            if(str != undefined) {
                let value = str.replace(/\"/g, '\\\"');
                value = str.replace(/\\/g, '\\\\');
                value = '\"' + value + '\"';
                return value;
            }
            else
                return undefined;
        }
        return undefined;
    }

    private getPrimDisplayValue(value: number | bigint, descriptor: string): number | bigint | string {
        if(descriptor === 'F')
            return this.binaryToFloat32(value as number);
        else if(descriptor === 'D')
            return this.binaryToFloat64(value as bigint);
        else if(descriptor === 'C')
            return '\'' + String.fromCharCode(value as number) + '\'';
        else if(descriptor === 'Z')
            return (value === 0) ? 'false' : 'true';
        else if(descriptor === 'J')
            return this.binaryToInt64(value as bigint);
        else
            return this.binaryToInt32(value as number);
    }

    private async readLocal(stackFrame: FlintStackFrame, variable: number | string): Promise<FlintValueInfo | undefined> {
        const localVariableInfo = stackFrame.getLocalVariableInfo(variable);
        if(!localVariableInfo)
            return undefined;
        const isU64 = localVariableInfo.descriptor === 'J' || localVariableInfo.descriptor === 'D'
        const txBuff = Buffer.alloc(10);
        txBuff[0] = FlintClientDebugger.DBG_CMD_READ_LOCAL;
        txBuff[1] = isU64 ? 1 : 0;
        txBuff[2] = (stackFrame.frameId >>> 0) & 0xFF;
        txBuff[3] = (stackFrame.frameId >>> 8) & 0xFF;
        txBuff[4] = (stackFrame.frameId >>> 16) & 0xFF;
        txBuff[5] = (stackFrame.frameId >>> 24) & 0xFF;
        txBuff[6] = (localVariableInfo.index >>> 0) & 0xFF;
        txBuff[7] = (localVariableInfo.index >>> 8) & 0xFF;
        txBuff[8] = (localVariableInfo.index >>> 16) & 0xFF;
        txBuff[9] = (localVariableInfo.index >>> 24) & 0xFF;
        const resp = await this.sendCmd(txBuff);
        if(!(resp && resp.cmd === FlintClientDebugger.DBG_CMD_READ_LOCAL && resp.responseCode === FlintClientDebugger.DBG_RESP_OK))
            return undefined;
        const size = this.readU32(resp.data, 0);
        let value: number | bigint | string = isU64 ? this.readU64(resp.data, 4) : this.readU32(resp.data, 4);
        const name = localVariableInfo.name;
        if(this.isPrimType(localVariableInfo.descriptor)) {
            value = this.getPrimDisplayValue(value as number | bigint, localVariableInfo.descriptor);
            return new FlintValueInfo(name, localVariableInfo.descriptor, value, size, 0);
        }
        else {
            let type: string;
            if(!isU64 && resp.receivedLength > 13) {
                const typeLength = this.readU16(resp.data, 8);
                type = resp.data.toString('utf-8', 12, 12 + typeLength);
            }
            else
                type = localVariableInfo.descriptor;
            const reference = value as number;
            const str = await this.checkAndReadString(reference, type);
            if(str)
                return new FlintValueInfo(name, type, str, size, reference);
            else
                return new FlintValueInfo(name, type, reference ? 0 : 'null', size, reference);
        }
    }

    private async readField(reference: number, fieldInfo: FlintFieldInfo): Promise<FlintValueInfo | undefined> {
        const txBuff = Buffer.alloc(5 + 4 + fieldInfo.name.length + 1);
        txBuff[0] = FlintClientDebugger.DBG_CMD_READ_FIELD;
        txBuff[1] = (reference >>> 0) & 0xFF;
        txBuff[2] = (reference >>> 8) & 0xFF;
        txBuff[3] = (reference >>> 16) & 0xFF;
        txBuff[4] = (reference >>> 24) & 0xFF;
        this.putConstUtf8ToBuffer(txBuff, fieldInfo.name, 5);
        const resp = await this.sendCmd(txBuff);
        if(!(resp && resp.cmd === FlintClientDebugger.DBG_CMD_READ_FIELD && resp.responseCode === FlintClientDebugger.DBG_RESP_OK))
            return undefined;
        const isU64 = fieldInfo.descriptor === 'J' || fieldInfo.descriptor === 'D';
        const size = this.readU32(resp.data, 0);
        let value: number | bigint | string = isU64 ? this.readU64(resp.data, 4) : this.readU32(resp.data, 4);
        const name = fieldInfo.name;
        if(this.isPrimType(fieldInfo.descriptor)) {
            value = this.getPrimDisplayValue(value as number | bigint, fieldInfo.descriptor);
            return new FlintValueInfo(name, fieldInfo.descriptor, value, size, 0);
        }
        else {
            let type: string;
            if(!isU64 && resp.receivedLength > 13) {
                const typeLength = this.readU16(resp.data, 8);
                type = resp.data.toString('utf-8', 12, 12 + typeLength);
            }
            else
                type = fieldInfo.descriptor;
            const reference = value as number;
            const str = await this.checkAndReadString(reference, type);
            if(str)
                return new FlintValueInfo(name, type, str, size, reference);
            else
                return new FlintValueInfo(name, type, reference ? 0 : 'null', size, reference);
        }
    }

    private async readArray(reference: number, index: number, length: number, arrayType: string): Promise<FlintValueInfo[] | undefined> {
        const txBuff = Buffer.alloc(12);
        txBuff[0] = FlintClientDebugger.DBG_CMD_READ_ARRAY;
        txBuff[1] = (length >>> 0) & 0xFF;
        txBuff[2] = (length >>> 8) & 0xFF;
        txBuff[3] = (length >>> 16) & 0xFF;
        txBuff[4] = (index >>> 0) & 0xFF;
        txBuff[5] = (index >>> 8) & 0xFF;
        txBuff[6] = (index >>> 16) & 0xFF;
        txBuff[7] = (index >>> 24) & 0xFF;
        txBuff[8] = (reference >>> 0) & 0xFF;
        txBuff[9] = (reference >>> 8) & 0xFF;
        txBuff[10] = (reference >>> 16) & 0xFF;
        txBuff[11] = (reference >>> 24) & 0xFF;
        const resp = await this.sendCmd(txBuff);
        if(!(resp && resp.cmd === FlintClientDebugger.DBG_CMD_READ_ARRAY && resp.responseCode === FlintClientDebugger.DBG_RESP_OK))
            return undefined;
        const elementSize = this.getElementTypeSize(arrayType);
        const elementType = arrayType.substring(1);
        const actualLength = resp.data.length / elementSize;
        const ret: FlintValueInfo[] = [];
        if(elementSize === 1) {
            for(let i = 0; i < actualLength; i++) {
                const name = '[' + i + ']';
                let value;
                if(elementType === 'Z')
                    value = ((resp.data[i] === 0) ? 'false' : 'true');
                else if(resp.data[i] & 0x80)
                    value = -(0x80 - (resp.data[i] & 0x7F))
                else
                    value = resp.data[i];
                ret.push(new FlintValueInfo(name, elementType, value, 1, 0));
            }
            return ret;
        }
        else if(elementSize === 2) {
            let index = 0;
            for(let i = 0; i < actualLength; i++) {
                const name = '[' + i + ']';
                let value: number | bigint | string = this.readU16(resp.data, index);
                index += 2;
                if(elementType === 'C')
                    value = '\'' + String.fromCharCode(value as number) + '\'';
                else if(value & 0x8000)
                    value = -(0x8000 - (value & 0x7FFF));
                ret.push(new FlintValueInfo(name, elementType, value, 1, 0));
            }
            return ret;
        }
        else if(elementSize === 4) {
            let index = 0;
            if(this.isPrimType(elementType)) {
                for(let i = 0; i < actualLength; i++) {
                    const name = '[' + i + ']';
                    let value: number | bigint = this.readU32(resp.data, index);
                    index += 4;
                    if(elementType === 'F')
                        value = this.binaryToFloat32(value as number);
                    ret.push(new FlintValueInfo(name, elementType, value, 4, 0));
                }
                return ret;
            }
            else {
                for(let i = 0; i < actualLength; i++) {
                    const reference = this.readU32(resp.data, index);
                    index += 4;
                    const sizeAndType = await this.readObjSizeAndType(reference);
                    if(sizeAndType === undefined)
                        return undefined;
                    const name = '[' + i + ']';
                    const size = sizeAndType[0];
                    const type = sizeAndType[1];
                    const str = await this.checkAndReadString(reference, type);
                    if(str)
                        ret.push(new FlintValueInfo(name, type, str, size, reference));
                    else
                        ret.push(new FlintValueInfo(name, type, reference ? 0 : 'null', size, reference));
                }
                return ret;
            }
        }
        else if(elementSize === 8) {
            let index = 0;
            for(let i = 0; i < actualLength; i++) {
                const name = '[' + i + ']';
                let value: number | bigint  = this.readU64(resp.data, index);
                if(elementType === 'D')
                    value = this.binaryToFloat64(value as bigint);
                index += 8;
                ret.push(new FlintValueInfo(name, elementType, value, 8, 0));
            }
            return ret;
        }
    }

    public async readVariable(reference: number): Promise<Variable[] | undefined> {
        if(!this.variableReferenceMap.has(reference))
            return undefined;
        const valueInfo = this.variableReferenceMap.get(reference);
        if(valueInfo === undefined)
            return undefined;
        if(this.isPrimType(valueInfo.type))
            return undefined;
        if(!this.isArrayType(valueInfo.type)) {
            const clsName = this.getSimpleNames(valueInfo.type)[0];
            const clsLoader = FlintClassLoader.load(clsName);
            const fieldInfos = clsLoader.getFieldList(true);
            if(!fieldInfos)
                return undefined;
            const filedValues: FlintValueInfo[] = [];
            for(let i = 0; i < fieldInfos.length; i++) {
                if(fieldInfos[i].accessFlag & FlintFieldInfo.FIELD_STATIC)
                    continue;
                const result = await this.readField(reference, fieldInfos[i]);
                if(result === undefined) {
                    const name = fieldInfos[i].name;
                    const descriptor = fieldInfos[i].descriptor;
                    filedValues.push(new FlintValueInfo(name, descriptor, 'not available', 0, 0));
                }
                else
                    filedValues.push(result);
            }
            this.addToRefMap(filedValues);
            return this.convertToVariable(filedValues);
        }
        else {
            const length = valueInfo.size / this.getElementTypeSize(valueInfo.type);
            const result = await this.readArray(reference, 0, length, valueInfo.type);
            if(result === undefined)
                return undefined;
            this.addToRefMap(result);
            return this.convertToVariable(result);
        }
    }

    public async readLocalVariables(frameId: number): Promise<Variable[] | undefined> {
        this.variableReferenceMap.clear();

        let stackFrame: FlintStackFrame;
        if(this.currentStackFrames && this.currentStackFrames.length > frameId)
            stackFrame = this.currentStackFrames[frameId];
        else {
            const tmp = await this.readStackFrame(frameId);
            if(tmp === undefined)
                return undefined;
            stackFrame = tmp;
        };

        if(stackFrame.localVariables === undefined)
            return undefined;
        const valueInfos: FlintValueInfo[] = [];
        for(let i = 0; i < stackFrame.localVariables.length; i++) {
            const result = await this.readLocal(stackFrame, i);
            if(result === undefined) {
                const name = stackFrame.localVariables[i].name;
                const descriptor = stackFrame.localVariables[i].descriptor;
                valueInfos.push(new FlintValueInfo(name, descriptor, 'not available', 0, 0));
            }
            else
                valueInfos.push(result);
        }
        this.addToRefMap(valueInfos);
        return this.convertToVariable(valueInfos);
    }

    private async startInstallFile(fileName: string): Promise<boolean> {
        const txBuff = Buffer.alloc(6 + fileName.length);
        txBuff[0] = FlintClientDebugger.DBG_CMD_INSTALL_FILE;
        this.putConstUtf8ToBuffer(txBuff, fileName, 1);
        const resp = await this.sendCmd(txBuff, 1000);
        if(resp && resp.cmd === FlintClientDebugger.DBG_CMD_INSTALL_FILE && resp.responseCode === FlintClientDebugger.DBG_RESP_OK)
            return true;
        else
            return false;
    }

    private async writeFile(data: Buffer, offset: number, length: number): Promise<boolean> {
        const txBuff = Buffer.alloc(1 + length);
        txBuff[0] = FlintClientDebugger.DBG_CMD_WRITE_FILE_DATA;
        for(let i = 0; i < length; i++)
            txBuff[i + 1] = data[i + offset];
        const resp = await this.sendCmd(txBuff, 1000);
        if(resp && resp.cmd === FlintClientDebugger.DBG_CMD_WRITE_FILE_DATA && resp.responseCode === FlintClientDebugger.DBG_RESP_OK)
            return true;
        else
            return false;
    }

    private async compaleInstallFile(): Promise<boolean> {
        const resp = await this.sendCmd(Buffer.from([FlintClientDebugger.DBG_CMD_COMPLATE_INSTAL]), 1000);
        if(resp && resp.cmd === FlintClientDebugger.DBG_CMD_COMPLATE_INSTAL && resp.responseCode === FlintClientDebugger.DBG_RESP_OK)
            return true;
        else
            return false;
    }

    public async installFile(filePath: string, fileName: string, progressChanged?: (progress: number, total: number) => void): Promise<boolean> {
        try {
            const data = fs.readFileSync(filePath, undefined);
            const startResult = await this.startInstallFile(fileName);
            if(!startResult)
                return false;
            let offset = 0;
            const blockSize = 512;
            let remainingSize = data.length - offset;
            while(remainingSize) {
                const length = (blockSize < remainingSize) ? blockSize : remainingSize;
                const writeResult = await this.writeFile(data, offset, length);
                if(!writeResult)
                    return false;
                offset += length;
                if(progressChanged)
                    progressChanged(offset, data.length);
                remainingSize = data.length - offset;
            }
            const complateResult = await this.compaleInstallFile();
            if(complateResult) {
                if(progressChanged)
                    progressChanged(data.length, data.length);
                return true;
            }
            else
                return false;
        }
        catch {
            return false;
        }
    }

    public disconnect() {
        this.currentStackFrames = undefined;
        this.currentStatus = FlintClientDebugger.DBG_STATUS_STOP;
        if(this.requestStatusTask) {
            clearTimeout(this.requestStatusTask);
            this.requestStatusTask = undefined;
        }
        this.client.disconnect();
    }

    private readU16(data: Buffer, offset : number): number {
        let ret = data[offset];
        ret |= data[offset + 1] << 8;
        return ret;
    }

    private readU32(data: Buffer, offset : number): number {
        let ret = data[offset];
        ret |= data[offset + 1] << 8;
        ret |= data[offset + 2] << 16;
        ret |= data[offset + 3] << 24;
        return ret >>> 0;
    }

    private readU64(data: Buffer, offset : number): bigint {
        let ret = BigInt(data[offset]);
        ret |= BigInt(data[offset + 1]) << 8n;
        ret |= BigInt(data[offset + 2]) << 16n;
        ret |= BigInt(data[offset + 3]) << 24n;
        ret |= BigInt(data[offset + 4]) << 32n;
        ret |= BigInt(data[offset + 5]) << 40n;
        ret |= BigInt(data[offset + 6]) << 48n;
        ret |= BigInt(data[offset + 7]) << 56n;
        return ret;
    }
}
