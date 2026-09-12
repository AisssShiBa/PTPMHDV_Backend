package com.ptpmhdv.userservice.dto;

import lombok.Data;

@Data
public class UpdateUserRequest {
    private String fullName;
    private String phone;
    private String address;
}
